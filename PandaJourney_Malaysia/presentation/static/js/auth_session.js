import {
  auth
} from "./firebase-config.js";

import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

const RELOAD_FLAG = "panda_session_synced_reload";

async function syncFlaskSession(user) {
  const response = await fetch("/api/auth/session", {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      uid: user.uid,
      email: user.email || "",
      displayName: user.displayName || ""
    })
  });

  if (!response.ok) {
    throw new Error("Could not sync Firebase user with Flask session.");
  }
}

onAuthStateChanged(auth, async function (user) {
  if (!user) {
    sessionStorage.removeItem(RELOAD_FLAG);
    return;
  }

  const serverUid = document.body.dataset.serverUserUid || "guest";

  if (serverUid === user.uid) {
    sessionStorage.removeItem(RELOAD_FLAG);
    return;
  }

  try {
    await syncFlaskSession(user);

    if (!sessionStorage.getItem(RELOAD_FLAG)) {
      sessionStorage.setItem(RELOAD_FLAG, "1");
      window.location.reload();
    }
  } catch (error) {
    console.error("Failed to sync auth session:", error);
  }
});
