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
  if (profileNavLink) {
    profileNavLink.style.setProperty(
      "display",
      user ? "flex" : "none",
      "important"
    );
  }

  if (!authNavButton) {
    return;
  }

  if (user) {
    localStorage.setItem(
      "pandajourney-authenticated",
      "true"
    );

    if (authNavIcon) {
      authNavIcon.textContent = "🚪";
    }

    if (authNavText) {
      authNavText.textContent = "Logout";
    }

    authNavButton.setAttribute(
      "aria-label",
      "Logout"
    );

    return;
  }

  localStorage.removeItem(
    "pandajourney-authenticated"
  );

  if (authNavIcon) {
    authNavIcon.textContent = "🔐";
  }

  if (authNavText) {
    authNavText.textContent = "Login";
  }

  authNavButton.setAttribute(
    "aria-label",
    "Login"
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

const logoutForm =
  document.getElementById("global-logout-form");


logoutForm?.addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    const logoutButton =
      logoutForm.querySelector(
        'button[type="submit"]'
      );

    try {
      if (logoutButton) {
        logoutButton.disabled = true;
        logoutButton.textContent =
          "Signing out...";
      }

      localStorage.removeItem(
      "pandajourney-authenticated"
    );

      await signOut(auth);
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

      window.location.replace("/login");

    } catch (error) {
      console.error(
        "Logout failed:",
        error
      );

      if (logoutButton) {
        logoutButton.disabled = false;
        logoutButton.textContent =
          "Sign out";
      }
    }
  }
);