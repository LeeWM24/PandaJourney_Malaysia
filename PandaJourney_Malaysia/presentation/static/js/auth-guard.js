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

const sessionExpiryWarning =
  document.getElementById("session-expiry-warning");

const keepSessionActiveButton =
  document.getElementById("keep-session-active");


// Inactivity Logout Configuration
// 30 minutes
const INACTIVITY_LIMIT_MS =
  30 * 60 * 1000;

const INACTIVITY_WARNING_MS =
  5 * 60 * 1000;

const LAST_ACTIVITY_KEY =
  "pandajourney-last-activity";

const INACTIVITY_MESSAGE_KEY =
  "pandajourney-auth-message";

let inactivityTimer = null;
let inactivityWarningTimer = null;
let activityListenersAdded = false;
let lastActivityRecordedAt = 0;
let logoutInProgress = false;


// =================================
// Firebase Authentication Guard
// =================================

onAuthStateChanged(auth, user => {
  updateAuthNavigation(user);

  if (user) {
    startInactivityMonitoring();
    return;
  }

  stopInactivityMonitoring();

  // Prevent the authentication listener from
  // redirecting before logout finishes.
  if (logoutInProgress) {
    return;
  }

  if (isPublicPage) {
    protectPublicPageNavigation();
    return;
  }

  redirectProtectedPageToLogin();
});


// =================================
// Inactivity Monitoring
// =================================

function startInactivityMonitoring() {
  let lastActivity = Number(
    localStorage.getItem(
      LAST_ACTIVITY_KEY
    )
  );

  if (
    !Number.isFinite(lastActivity) ||
    lastActivity <= 0
  ) {
    lastActivity = Date.now();

    localStorage.setItem(
      LAST_ACTIVITY_KEY,
      String(lastActivity)
    );
  }

  if (!activityListenersAdded) {
    const activityEvents = [
      "pointerdown",
      "pointermove",
      "keydown",
      "scroll",
      "touchstart"
    ];

    activityEvents.forEach(eventName => {
      window.addEventListener(
        eventName,
        recordUserActivity,
        {
          passive: true
        }
      );
    });

    // Synchronise activity between browser tabs.
    window.addEventListener(
      "storage",
      handleActivityStorageChange
    );

    activityListenersAdded = true;
  }

  scheduleInactivityLogout();
}


function recordUserActivity() {
  if (
    !auth.currentUser ||
    logoutInProgress
  ) {
    return;
  }

  const now = Date.now();

  // Prevent excessive localStorage writes
  // during continuous pointer movement.
  if (
    now - lastActivityRecordedAt < 1000
  ) {
    return;
  }

  lastActivityRecordedAt = now;

  localStorage.setItem(
    LAST_ACTIVITY_KEY,
    String(now)
  );

  scheduleInactivityLogout();
}


function handleActivityStorageChange(event) {
  if (
    event.key === LAST_ACTIVITY_KEY &&
    auth.currentUser
  ) {
    scheduleInactivityLogout();
  }
}


function scheduleInactivityLogout() {
  clearTimeout(inactivityTimer);
  clearTimeout(inactivityWarningTimer);
  hideInactivityWarning();

  const lastActivity = Number(
    localStorage.getItem(
      LAST_ACTIVITY_KEY
    )
  ) || Date.now();

  const elapsed =
    Date.now() - lastActivity;

  const remaining =
    Math.max(
      0,
      INACTIVITY_LIMIT_MS - elapsed
    );

  inactivityTimer = setTimeout(
    performAutomaticLogout,
    remaining
  );

  if (remaining > INACTIVITY_WARNING_MS) {
    inactivityWarningTimer = setTimeout(
      showInactivityWarning,
      remaining - INACTIVITY_WARNING_MS
    );
  } else {
    showInactivityWarning();
  }
}

function showInactivityWarning() {
  if (sessionExpiryWarning && auth.currentUser && !logoutInProgress) {
    sessionExpiryWarning.hidden = false;
  }
}

function hideInactivityWarning() {
  if (sessionExpiryWarning) {
    sessionExpiryWarning.hidden = true;
  }
}

keepSessionActiveButton?.addEventListener("click", () => {
  lastActivityRecordedAt = 0;
  recordUserActivity();
  keepSessionActiveButton.blur();
});


function stopInactivityMonitoring() {
  clearTimeout(inactivityTimer);
  clearTimeout(inactivityWarningTimer);
  inactivityTimer = null;
  inactivityWarningTimer = null;
  hideInactivityWarning();
}


async function performAutomaticLogout() {
  if (
    !auth.currentUser ||
    logoutInProgress
  ) {
    return;
  }

  logoutInProgress = true;
  stopInactivityMonitoring();

  // This message will be displayed
  // after redirecting to Login.
  sessionStorage.setItem(
    INACTIVITY_MESSAGE_KEY,
    "Your session expired due to inactivity. Please sign in again."
  );

  try {
    await signOut(auth);

    const response = await fetch(
      "/logout",
      {
        method: "POST",
        credentials: "same-origin"
      }
    );

    if (!response.ok) {
      console.error(
        "Failed to clear the server session after inactivity."
      );
    }
  } catch (error) {
    console.error(
      "Automatic logout failed:",
      error
    );
  } finally {
    localStorage.removeItem(
      "pandajourney-authenticated"
    );

    localStorage.removeItem(
      LAST_ACTIVITY_KEY
    );

    document.documentElement.classList.remove(
      "likely-authenticated"
    );

    window.location.replace("/login");
  }
}


// =================================
// Navigation Authentication State
// =================================

function updateAuthNavigation(user) {
  const isLoggedIn =
    Boolean(user);

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


// =================================
// Login Button
// =================================

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


// =================================
// Protected Page Redirect
// =================================

function redirectProtectedPageToLogin() {
  const target =
    window.location.pathname +
    window.location.search +
    window.location.hash;

  window.location.replace(
    `/login?next=${encodeURIComponent(target)}`
  );
}


// =================================
// Public Page Navigation Protection
// =================================

function protectPublicPageNavigation() {
  const protectedLinks =
    document.querySelectorAll(
      ".sidebar-nav a, .sidebar-footer a"
    );

  protectedLinks.forEach(link => {
    link.addEventListener(
      "click",
      event => {
        const href =
          link.getAttribute("href");

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

        if (
          url.origin !==
          window.location.origin
        ) {
          return;
        }

        const isAttractionPage =
          url.pathname === "/" ||
          url.pathname === "/attractions" ||
          url.pathname ===
            "/smart-attraction";

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
      }
    );
  });
}


// =================================
// Manual Logout
// =================================

logoutForm?.addEventListener(
  "submit",
  async event => {
    event.preventDefault();

    const logoutButton =
      logoutForm.querySelector(
        'button[type="submit"]'
      );

    if (logoutError) {
      logoutError.textContent = "";
      logoutError.hidden = true;
    }

    try {
      logoutInProgress = true;
      stopInactivityMonitoring();

      if (logoutButton) {
        logoutButton.disabled = true;
        logoutButton.textContent =
          "Signing out...";
      }

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

      localStorage.removeItem(
        "pandajourney-authenticated"
      );

      localStorage.removeItem(
        LAST_ACTIVITY_KEY
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

      logoutInProgress = false;

      if (auth.currentUser) {
        startInactivityMonitoring();
      }
    }
  }
);
