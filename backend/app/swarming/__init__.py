"""Swarming Assay. The pixel cap is set here, before any module of this package imports cv2:
OpenCV reads OPENCV_IO_MAX_IMAGE_PIXELS once, when it loads, and ignores it if set later.
With it, a photo over the cap is refused from its header, before it takes any memory."""

import os

MAX_PHOTO_PIXELS = 50_000_000

os.environ["OPENCV_IO_MAX_IMAGE_PIXELS"] = str(MAX_PHOTO_PIXELS)
