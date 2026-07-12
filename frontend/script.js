// 本機測試時保持 localhost:8000 即可
// const BACKEND_URL = "http://127.0.0.1:8000";
const BACKEND_URL = "https://igem-ncku-software.onrender.com";

const form = document.getElementById("analyze-form");
const textInput = document.getElementById("text-input");
const imageInput = document.getElementById("image-input");
const imagePreview = document.getElementById("image-preview");
const submitBtn = document.getElementById("submit-btn");
const resultSection = document.getElementById("result-section");
const resultOutput = document.getElementById("result-output");
const statusMessage = document.getElementById("status-message");
const backendStatus = document.getElementById("backend-status");

// 圖片預覽
imageInput.addEventListener("change", () => {
  const file = imageInput.files[0];
  if (!file) {
    imagePreview.hidden = true;
    return;
  }
  imagePreview.src = URL.createObjectURL(file);
  imagePreview.hidden = false;
});

// 送出表單給後端
form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const text = textInput.value.trim();
  const imageFile = imageInput.files[0];

  if (!text && !imageFile) {
    statusMessage.textContent = "請至少輸入文字或選擇一張圖片。";
    return;
  }

  const formData = new FormData();
  formData.append("text", text);
  if (imageFile) {
    formData.append("image", imageFile);
  }

  submitBtn.disabled = true;
  statusMessage.textContent = "傳送中，請稍候...";
  resultSection.hidden = true;

  try {
    const response = await fetch(`${BACKEND_URL}/api/analyze`, {
      method: "POST",
      body: formData,
    });

    if (!response.ok) {
      throw new Error(`後端回應錯誤：${response.status}`);
    }

    const data = await response.json();
    resultOutput.textContent = JSON.stringify(data, null, 2);
    resultSection.hidden = false;
    statusMessage.textContent = "分析完成。";
  } catch (err) {
    statusMessage.textContent = `發生錯誤：${err.message}（請確認後端是否已啟動，或 BACKEND_URL 是否正確）`;
  } finally {
    submitBtn.disabled = false;
  }
});

// 頁面載入時檢查後端是否連得上
async function checkBackend() {
  try {
    const res = await fetch(`${BACKEND_URL}/health`);
    if (res.ok) {
      backendStatus.textContent = "已連線";
    } else {
      backendStatus.textContent = "無回應";
    }
  } catch {
    backendStatus.textContent = "連線失敗";
  }
}
checkBackend();
