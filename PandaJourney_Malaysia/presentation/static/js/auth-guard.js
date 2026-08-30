import {
  auth
} from "./firebase-config.js";

import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";


const isPublicPage =
  document.body.dataset.publicPage ===
  "true";


if (!isPublicPage) {
  onAuthStateChanged(
    auth,
    user => {
      if (user) {
        return;
      }

      const target =
        window.location.pathname +
        window.location.search +
        window.location.hash;

      window.location.replace(
        `/login?next=${encodeURIComponent(target)}`
      );
    }
  );
}