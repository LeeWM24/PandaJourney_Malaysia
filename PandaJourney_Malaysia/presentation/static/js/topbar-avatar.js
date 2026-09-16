import { auth, db } from "./firebase-config.js";

import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

const avatarImage = document.getElementById("avatarImage");
const avatarInitials = document.getElementById("avatarInitials");
const topbarAvatar = document.getElementById("dashboardAvatar");
const topbarUserName = document.getElementById("topbarUserName");

function renderAvatar({ type = "", emoji = "", uploadUrl = "", googleUrl = "", name = "" }) {
  if (!avatarImage || !avatarInitials) return;

  if (type === "upload" && uploadUrl) {
    avatarImage.src = uploadUrl;
    avatarImage.style.display = "block";
    avatarInitials.style.display = "none";
    return;
  }

  if (type === "emoji" && emoji) {
    avatarImage.removeAttribute("src");
    avatarImage.style.display = "none";
    avatarInitials.textContent = emoji;
    avatarInitials.style.display = "flex";
    return;
  }

  if ((type === "google" || !type) && googleUrl) {
    avatarImage.src = googleUrl;
    avatarImage.style.display = "block";
    avatarInitials.style.display = "none";
    return;
  }

  avatarImage.removeAttribute("src");
  avatarImage.style.display = "none";
  avatarInitials.textContent = name.charAt(0).toUpperCase() || "?";
  avatarInitials.style.display = "flex";
}

onAuthStateChanged(auth, async user => {
  if (!user) {
    topbarAvatar?.setAttribute("hidden", "");
    return;
  }

  topbarAvatar?.removeAttribute("hidden");

  let name = user.displayName || user.email?.split("@")[0] || "Traveller";
  let avatarType = "";
  let avatar = "";
  let avatarUrl = "";
  let authProvider = "";

  try {
    const snapshot = await getDoc(doc(db, "users", user.uid));
    if (snapshot.exists()) {
      const data = snapshot.data();
      name = data.displayName || name;
      avatarType = data.avatarType || (data.avatar ? "emoji" : "");
      avatar = data.avatar || "";
      avatarUrl = data.avatarUrl || "";
      authProvider = data.authProvider || "";
    }
  } catch (error) {
    console.warn("Unable to load topbar avatar:", error);
  }

  renderAvatar({
    type: avatarType,
    emoji: avatar,
    uploadUrl: avatarUrl,
    googleUrl: authProvider === "google" ? user.photoURL || "" : "",
    name: user.email || name
  });

  if (topbarUserName) {
    topbarUserName.textContent = name;
  }
});
