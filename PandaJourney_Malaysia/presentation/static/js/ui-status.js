const bannerId = "app-connection-status";

function ensureStyles() {
  if (document.getElementById("app-status-styles")) return;
  const style = document.createElement("style");
  style.id = "app-status-styles";
  style.textContent = `
    .app-status-banner { position: sticky; top: 0; z-index: 10000; display: flex; align-items: center; justify-content: center; gap: 10px; padding: 10px 16px; color: #92400e; background: #fffbeb; border-bottom: 1px solid #fcd34d; font-size: 14px; font-weight: 700; text-align: center; }
    .app-status-banner[hidden] { display: none; }
    .app-status-message { margin: 12px 0; padding: 12px 14px; border: 1px solid; border-radius: 10px; font-size: 14px; font-weight: 600; line-height: 1.45; }
    .app-status-message.error { color: #991b1b; background: #fef2f2; border-color: #fecaca; }
    .app-status-message.success { color: #166534; background: #f0fdf4; border-color: #bbf7d0; }
    .app-status-message.warning { color: #92400e; background: #fffbeb; border-color: #fde68a; }
    [aria-busy="true"] { cursor: wait; opacity: .72; }
  `;
  document.head.appendChild(style);
}

function ensureBanner() {
  let banner = document.getElementById(bannerId);
  if (banner) return banner;
  banner = document.createElement("div");
  banner.id = bannerId;
  banner.className = "app-status-banner";
  banner.setAttribute("role", "status");
  banner.setAttribute("aria-live", "polite");
  banner.hidden = true;
  document.body.prepend(banner);
  return banner;
}

function updateConnectionStatus() {
  const banner = ensureBanner();
  banner.textContent = navigator.onLine
    ? "Connection restored. You can continue."
    : "You are offline. Check your internet connection before trying again.";
  banner.hidden = navigator.onLine;
}

function friendlyError(error, fallback = "Something went wrong. Please try again.") {
  if (!navigator.onLine || error?.code === "auth/network-request-failed" || error?.code === "unavailable") return "Network error. Check your internet connection and try again.";
  if (error?.code === "permission-denied") return "You do not have permission to complete this action. Please sign in again if this is your account.";
  if (error?.code === "unauthenticated") return "Your session has expired. Please sign in again.";
  if (error?.code === "resource-exhausted") return "The service is busy right now. Please wait a moment and try again.";
  return fallback;
}

function show(target, message, type = "error") {
  const element = typeof target === "string" ? document.querySelector(target) : target;
  if (!element) return;
  element.textContent = message;
  element.className = `app-status-message ${type}`;
  element.hidden = false;
  element.style.display = "block";
  element.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function clear(target) {
  const element = typeof target === "string" ? document.querySelector(target) : target;
  if (!element) return;
  element.textContent = "";
  element.hidden = true;
  element.style.display = "none";
}

ensureStyles();
updateConnectionStatus();
window.addEventListener("offline", updateConnectionStatus);
window.addEventListener("online", updateConnectionStatus);
window.PandaFeedback = { friendlyError, show, clear };
