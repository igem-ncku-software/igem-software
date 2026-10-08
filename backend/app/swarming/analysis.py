"""Swarming Assay: the team's colony-measurement notebook (iGEM_cv.ipynb), run on the backend.

Original analysis: Tzu-Chiao Chou (iGEM NCKU-Tainan 2026), iGEM_cv.ipynb.
Integrated into LasReader by Yu-Chun Sung.

The detection and measurement are the notebook's code, step for step, with its parameters and
their values. Only the input and output changed to fit a web request:

- the photo arrives as bytes from an upload (`cv2.imdecode`) instead of a Google Drive path
  (`cv2.imread`); both read it as 3-channel BGR;
- `ACTUAL_DISH_DIAMETER_MM` is an argument, defaulting to the notebook's 93 mm, since a plate
  of another size would scale every result wrongly;
- what the notebook printed (plate, scale, the purple fraction and the mode it chose, the colony
  table, "Hough found no plate") and the figure it showed are returned instead: the numbers as a
  dict, the annotated image as PNG bytes. The thresholds the notebook kept in `thr_label` (but
  did not print) are returned too, as numbers.

Changing a formula, threshold or rule here changes every result, so keep it the notebook's.
"""

from __future__ import annotations

import cv2
import numpy as np

# ==========================================
# Parameters (the notebook's)
# ==========================================
INNER_RATIO = 0.90          # detection area as a share of the plate radius; widen for many colonies
SIGMA_RATIO = 0.15          # background blur; larger for large colonies
USE_OTSU = True             # defined in the notebook, not used by it
PERCENTILE = 94             # defined in the notebook, not used by it
MIN_AREA_PX = 500
MIN_CIRCULARITY = 0.3       # defined in the notebook, not used by it
MAX_COLONIES = 10
SHOW_DEBUG = True
SCALE_BAR_MM = 10
RED = (0, 0, 255)
ACTUAL_DISH_DIAMETER_MM = 93

# Purple / UV background detection.
UV_FRAC_THRESHOLD = 0.35    # blue-purple pixels above this share of the whole photo -> UV
UV_HALF = 0.5               # UV-mode threshold position between background and colony peak, 0.4-0.6

# Watershed: split only regions that don't look like one colony.
SPLIT_SOLIDITY = 0.80       # below this, something is stuck to it and it is split
CORE_RATIO = 0.5


class PhotoUnreadable(ValueError):
    """The upload could not be decoded as an image."""


def decode_photo(data: bytes) -> np.ndarray:
    """The upload as a BGR image, as `cv2.imread` would have read the file."""
    img = cv2.imdecode(np.frombuffer(data, dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise PhotoUnreadable("The file could not be read as an image.")
    return img


def analyze(img: np.ndarray, dish_diameter_mm: float = ACTUAL_DISH_DIAMETER_MM) -> dict:
    """Find the plate and the colonies in a BGR photo and measure each colony.

    Returns {dish, mm_per_px, mode, purple_fraction, threshold, image, colonies, annotated_png}: see swarming.js for the shape.
    """
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape

    # ==========================================
    # Step 1: find the plate -> scale
    # ==========================================
    target_width = 800.0
    scale = target_width / w
    gray_resized = cv2.resize(gray, (0, 0), fx=scale, fy=scale)
    blur_for_dish = cv2.GaussianBlur(gray_resized, (9, 9), 0)

    circles = cv2.HoughCircles(
        blur_for_dish, cv2.HOUGH_GRADIENT, dp=1.2,
        minDist=target_width * 0.5,
        param1=100, param2=40,
        minRadius=int(target_width * 0.30),
        maxRadius=int(target_width * 0.50)
    )

    if circles is not None:
        x, y, r = circles[0][0]                       # the circle with the most votes
        dish_x, dish_y, dish_r = int(x / scale), int(y / scale), int(r / scale)
        dish_method = "hough"
    else:
        _, bw = cv2.threshold(cv2.GaussianBlur(gray, (21, 21), 0), 0, 255,
                              cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        cs, _ = cv2.findContours(bw, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        (fx, fy), fr = cv2.minEnclosingCircle(max(cs, key=cv2.contourArea))
        dish_x, dish_y, dish_r = int(fx), int(fy), int(fr)
        dish_method = "contour"                       # the notebook printed "Hough found no plate"

    mm_per_px = dish_diameter_mm / (dish_r * 2)

    # ==========================================
    # Is the background purple / UV?
    # ==========================================
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    Hh, Ss, Vv = cv2.split(hsv)
    purple_frac = ((Hh >= 100) & (Hh <= 165) & (Ss > 50) & (Vv > 40)).mean()
    IS_UV = purple_frac > UV_FRAC_THRESHOLD

    # ==========================================
    # Step 2: colony detection (background correction + Otsu + watershed)
    # ==========================================
    inner_r = int(dish_r * INNER_RATIO)
    mask = np.zeros_like(gray)
    cv2.circle(mask, (dish_x, dish_y), inner_r, 255, -1)
    inside = mask > 0

    gray_f = gray.astype(np.float32)
    filled = gray_f.copy()
    filled[~inside] = np.median(gray_f[inside])

    bg = cv2.GaussianBlur(filled, (0, 0), w * SIGMA_RATIO)
    corrected = cv2.GaussianBlur(gray_f - bg, (9, 9), 0)

    if IS_UV:
        # ---------- UV mode: the G/B ratio finds the cyan-green regions ----------
        b, g, r = [c.astype(np.float32) for c in cv2.split(img)]
        ratio = g / (b + 1.0)
        ratio = cv2.GaussianBlur(ratio, (0, 0), max(1.5, dish_r * 0.005))

        vals = ratio[inside]
        base = np.median(vals)
        peak = np.percentile(vals, 99.8)
        uv_thr = base + UV_HALF * (peak - base)

        thresh = ((ratio > uv_thr) & inside).astype(np.uint8) * 255
        corrected = ratio
        threshold = {"uv_base": float(base), "uv_peak": float(peak), "uv_thr": float(uv_thr)}

    else:
        # ---------- Normal mode: Otsu + core filter ----------
        vals = corrected[inside]
        lo, hi = np.percentile(vals, [1, 99.5])
        norm = np.clip((corrected - lo) / (hi - lo + 1e-6) * 255, 0, 255).astype(np.uint8)
        otsu_thr, _ = cv2.threshold(norm[inside].reshape(-1, 1), 0, 255,
                                    cv2.THRESH_BINARY + cv2.THRESH_OTSU)

        # Loose outline: Otsu raised a little
        loose_thr = otsu_thr * 1.1
        loose = ((norm > loose_thr) & inside).astype(np.uint8) * 255

        # Core: pixels far above Otsu (a colony always has some, a reflection doesn't)
        core_thr = otsu_thr + 0.6 * (255 - otsu_thr)
        core = ((norm > core_thr) & inside).astype(np.uint8) * 255

        # Fill holes
        cnts, _ = cv2.findContours(loose, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        filled = np.zeros_like(loose)
        cv2.drawContours(filled, cnts, -1, 255, -1)
        loose = filled

        # Keep only the connected regions that contain core
        n_l, lab_l = cv2.connectedComponents(loose)
        thresh = np.zeros_like(loose)
        for l in range(1, n_l):
            comp = lab_l == l
            if (core[comp] > 0).sum() >= 30:
                thresh[comp] = 255

        threshold = {"otsu": float(otsu_thr), "loose": float(loose_thr), "core": float(core_thr)}

    # ---------- Morphology ----------
    k_open = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
    k_close = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))
    thresh = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, k_open)
    thresh = cv2.morphologyEx(thresh, cv2.MORPH_CLOSE, k_close)

    # ---------- Fill holes ----------
    cnts, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    filled_mask = np.zeros_like(thresh)
    cv2.drawContours(filled_mask, cnts, -1, 255, -1)
    thresh = filled_mask

    # ---------- Watershed: split only regions that don't look like one colony ----------
    dist = cv2.distanceTransform(thresh, cv2.DIST_L2, 5)
    n_cc, cc_labels = cv2.connectedComponents(thresh)

    contours = []
    for lab in range(1, n_cc):
        region = (cc_labels == lab).astype(np.uint8) * 255
        cs, _ = cv2.findContours(region, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        c0 = max(cs, key=cv2.contourArea)
        area0 = cv2.contourArea(c0)
        if area0 < 200:
            continue
        solidity0 = area0 / (cv2.contourArea(cv2.convexHull(c0)) + 1e-6)

        if solidity0 >= SPLIT_SOLIDITY:
            contours.append(c0)          # one clean colony: used as is, not split
            continue

        # Looks stuck to a reflection: watershed this region on its own
        reg = cc_labels == lab
        sure_fg = np.zeros_like(thresh)
        sure_fg[reg & (dist > CORE_RATIO * dist[reg].max())] = 255
        n, markers = cv2.connectedComponents(sure_fg)
        markers = markers + 1
        markers[(region > 0) & (sure_fg == 0)] = 0
        markers[region == 0] = 1
        markers = cv2.watershed(img.copy(), markers)
        for m_lab in range(2, n + 1):
            m = (markers == m_lab).astype(np.uint8) * 255
            cs2, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            contours += cs2

    # ==========================================
    # Step 3: keep every colony that qualifies
    # ==========================================
    colonies = []
    for c in contours:
        area = cv2.contourArea(c)
        if area < MIN_AREA_PX:
            continue
        (cx, cy), rad = cv2.minEnclosingCircle(c)
        if np.hypot(cx - dish_x, cy - dish_y) + rad > inner_r * 0.98:    # touches the edge -> reflection
            continue

        hull_area = cv2.contourArea(cv2.convexHull(c))
        solidity = area / (hull_area + 1e-6)
        (_, _), (rw, rh), _ = cv2.minAreaRect(c)
        aspect = max(rw, rh) / (min(rw, rh) + 1e-6)

        if solidity < 0.6 or aspect > 2.5:                               # elongated or broken -> reflection
            continue
        colonies.append(c)

    colonies = sorted(colonies, key=cv2.contourArea, reverse=True)[:MAX_COLONIES]

    def centroid(c):
        m = cv2.moments(c)
        return (m["m10"] / m["m00"], m["m01"] / m["m00"])
    colonies = sorted(colonies, key=lambda c: (round(centroid(c)[1] / (dish_r * 0.4)), centroid(c)[0]))

    # ==========================================
    # Step 4: measure and annotate
    # ==========================================
    output = img.copy()
    thick = max(2, int(w / 800 * 3))
    font_scale = w / 800 * 0.8
    tt = max(2, int(w / 800 * 2))                  # red text thickness
    outline = tt * 5                               # black outline thickness

    def put_text(im, text, pos, scale=font_scale, color=RED):
        cv2.putText(im, text, pos, cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), outline, cv2.LINE_AA)  # black outline
        cv2.putText(im, text, pos, cv2.FONT_HERSHEY_SIMPLEX, scale, color, tt, cv2.LINE_AA)            # red text

    def draw_dimension(im, p1, p2, label, offset):
        p1, p2 = np.array(p1, float), np.array(p2, float)
        cv2.line(im, tuple(p1.astype(int)), tuple(p2.astype(int)), RED, thick)
        v = (p2 - p1) / (np.linalg.norm(p2 - p1) + 1e-6)
        n = np.array([-v[1], v[0]]) * (8 * w / 800)
        for p in (p1, p2):
            cv2.line(im, tuple((p - n).astype(int)), tuple((p + n).astype(int)), RED, thick)
        put_text(im, label, tuple(offset.astype(int)))

    if SHOW_DEBUG:
        cv2.circle(output, (dish_x, dish_y), dish_r, (0, 255, 0), thick)

    results = []
    for idx, c in enumerate(colonies, start=1):
        area_px = cv2.contourArea(c)
        hull = cv2.convexHull(c)[:, 0, :].astype(np.float32)
        dist = np.linalg.norm(hull[:, None, :] - hull[None, :, :], axis=2)
        i, j = np.unravel_index(np.argmax(dist), dist.shape)
        p1, p2 = hull[i], hull[j]

        feret_mm = dist[i, j] * mm_per_px
        eq_mm = np.sqrt(4 * area_px / np.pi) * mm_per_px
        area_mm2 = area_px * mm_per_px ** 2
        results.append((idx, feret_mm, eq_mm, area_mm2))

        if SHOW_DEBUG:
            cv2.drawContours(output, [c], -1, (0, 255, 255), thick)

        # Label at the line's midpoint, offset perpendicular so it doesn't sit on the colony
        mid = (p1 + p2) / 2
        v = (p2 - p1) / (np.linalg.norm(p2 - p1) + 1e-6)
        nrm = np.array([-v[1], v[0]])
        text_pos = mid + nrm * (25 * w / 800) - np.array([30 * w / 800, 0])
        draw_dimension(output, p1, p2, f"#{idx} {feret_mm:.1f} mm", text_pos)

    # Scale bar
    bar_px = int(SCALE_BAR_MM / mm_per_px)
    margin = int(w * 0.06)
    x2, y = w - margin, h - margin
    x1 = x2 - bar_px
    cv2.line(output, (x1, y), (x2, y), RED, thick)
    for x in (x1, x2):
        cv2.line(output, (x, y - int(8 * w / 800)), (x, y + int(8 * w / 800)), RED, thick)
    put_text(output, f"{SCALE_BAR_MM} mm", (x1 + bar_px // 2 - int(30 * w / 800), y - int(18 * w / 800)))

    ok, png = cv2.imencode(".png", output)
    if not ok:
        raise RuntimeError("The annotated image could not be encoded as PNG.")

    return {
        "dish": {
            "x_px": dish_x,
            "y_px": dish_y,
            "radius_px": dish_r,
            "diameter_mm": float(dish_diameter_mm),
            "method": dish_method,
        },
        "mm_per_px": float(mm_per_px),
        "mode": "uv" if IS_UV else "normal",
        "purple_fraction": float(purple_frac),
        "threshold": threshold,
        "image": {"width_px": int(w), "height_px": int(h)},
        "colonies": [
            {"index": idx, "feret_mm": float(f), "eq_diameter_mm": float(e), "area_mm2": float(a)}
            for idx, f, e, a in results
        ],
        "annotated_png": png.tobytes(),
    }
