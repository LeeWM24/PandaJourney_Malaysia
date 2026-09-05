import {
  auth
} from "./firebase-config.js";

import {
  onAuthStateChanged,
  signOut
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";


const isPublicPage =
  document.body.dataset.publicPage === "true";

const authNavButton =
  document.getElementById("auth-nav-button");

const authNavIcon =
  document.getElementById("auth-nav-icon");

const authNavText =
  document.getElementById("auth-nav-text");

const profileNavLink =
  document.getElementById("profile-nav-link");

const logoutForm =
  document.getElementById("global-logout-form");

const logoutError =
  document.getElementById("logout-error");

onAuthStateChanged(auth, user => {
  updateAuthNavigation(user);

  if (user) {
    return;
  }

  if (isPublicPage) {
    protectPublicPageNavigation();
    return;
  }

  redirectProtectedPageToLogin();
});

function updateAuthNavigation(user) {
  const isLoggedIn = Boolean(user);

  document.documentElement.classList.toggle(
    "likely-authenticated",
    isLoggedIn
  );

  if (profileNavLink) {
    profileNavLink.setAttribute(
      "aria-hidden",
      isLoggedIn ? "false" : "true"
    );
  }

  if (isLoggedIn) {
    localStorage.setItem(
      "pandajourney-authenticated",
      "true"
    );
  } else {
    localStorage.removeItem(
      "pandajourney-authenticated"
    );
  }

  if (!authNavButton) {
    return;
  }

  if (authNavIcon) {
    authNavIcon.textContent =
      isLoggedIn ? "🚪" : "🔐";
  }

  if (authNavText) {
    authNavText.textContent =
      isLoggedIn ? "Logout" : "Login";
  }

  authNavButton.setAttribute(
    "aria-label",
    isLoggedIn ? "Logout" : "Login"
  );
}

authNavButton?.addEventListener(
  "click",
  event => {
    if (auth.currentUser) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();

    const currentPage =
      window.location.pathname;

    window.location.href =
      `/login?next=${encodeURIComponent(currentPage)}`;
  },
  true
);

function redirectProtectedPageToLogin() {
  const target =
    window.location.pathname +
    window.location.search +
    window.location.hash;

  window.location.replace(
    `/login?next=${encodeURIComponent(target)}`
  );
}


function protectPublicPageNavigation() {
  const protectedLinks =
    document.querySelectorAll(
      ".sidebar-nav a, .sidebar-footer a"
    );

  protectedLinks.forEach(link => {
    link.addEventListener("click", event => {
      const href = link.getAttribute("href");

      if (
        !href ||
        href === "#" ||
        href.startsWith("javascript:")
      ) {
        return;
      }

      const url = new URL(
        link.href,
        window.location.origin
      );

      if (url.origin !== window.location.origin) {
        return;
      }

      const isAttractionPage =
        url.pathname === "/" ||
        url.pathname === "/smart-attraction";

      if (isAttractionPage) {
        return;
      }

      event.preventDefault();

      const target =
        url.pathname +
        url.search +
        url.hash;

      window.location.href =
        `/login?next=${encodeURIComponent(target)}`;
    });
  });
}

logoutForm?.addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    const logoutButton =
      logoutForm.querySelector(
        'button[type="submit"]'
      );

    // Clear previous error
    if (logoutError) {
      logoutError.textContent = "";
      logoutError.hidden = true;
    }

    try {
      if (logoutButton) {
        logoutButton.disabled = true;
        logoutButton.textContent =
          "Signing out...";
      }

      // Sign out from Firebase
      await signOut(auth);

      // Clear Flask server session
      const response = await fetch(
        "/logout",
        {
          method: "POST",
          credentials: "same-origin"
        }
      );

      if (!response.ok) {
        throw new Error(
          "Failed to clear server session."
        );
      }

      // Only clear the navigation hint
      // after logout succeeds.
      localStorage.removeItem(
        "pandajourney-authenticated"
      );

      document.documentElement.classList.remove(
        "likely-authenticated"
      );

      window.location.replace("/login");

    } catch (error) {
      console.error(
        "Logout failed:",
        error
      );

      // UC_500 M1
      if (logoutError) {
        logoutError.textContent =
          "Unable to sign out. Please try again.";

        logoutError.hidden = false;
      }

      if (logoutButton) {
        logoutButton.disabled = false;
        logoutButton.textContent =
          "Sign out";
      }
    }
  }
);