import {
  auth
} from "./firebase-config.js";

import {
  signInWithEmailAndPassword,
  sendEmailVerification,
  signOut
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

const form =
  document.getElementById("resend-verification-form");

const emailInput =
  document.getElementById("resend-email");

const passwordInput =
  document.getElementById("resend-password");

const submitButton =
  document.getElementById("resend-verification-submit");

const messageElement =
  document.getElementById("resend-verification-message");

const passwordToggle =
  document.getElementById("resend-password-toggle");

let requestPending = false;

function showMessage(message, type = "error") {
  if (!messageElement) {
    return;
  }

  messageElement.textContent = message;
  messageElement.className =
    `login-message ${type} show`;
  messageElement.setAttribute(
    "role",
    type === "error" ? "alert" : "status"
  );
  messageElement.setAttribute(
    "aria-live",
    type === "error" ? "assertive" : "polite"
  );
}

function authenticationMessage(error) {
  switch (error?.code) {
    case "auth/invalid-email":
      return "Please enter a valid email address.";
    case "auth/invalid-credential":
    case "auth/user-not-found":
    case "auth/wrong-password":
      return "The email or password is incorrect.";
    case "auth/too-many-requests":
      return "Too many attempts. Please wait before trying again.";
    case "auth/network-request-failed":
      return "Network error. Check your connection and try again.";
    default:
      return "Unable to resend the verification email. Please try again.";
  }
}

passwordToggle?.addEventListener("click", () => {
  if (!passwordInput) {
    return;
  }

  const willShow =
    passwordInput.type === "password";

  passwordInput.type =
    willShow ? "text" : "password";

  passwordToggle.textContent =
    willShow ? "Hide" : "Show";

  passwordToggle.setAttribute(
    "aria-label",
    `${willShow ? "Hide" : "Show"} password`
  );
});

form?.addEventListener("submit", async event => {
  event.preventDefault();

  if (requestPending) {
    return;
  }

  const email =
    emailInput?.value.trim() || "";

  const password =
    passwordInput?.value || "";

  if (!email || !password) {
    showMessage(
      "Enter both your email address and password."
    );
    return;
  }

  if (!emailInput?.checkValidity()) {
    showMessage(
      "Please enter a valid email address."
    );
    emailInput?.focus();
    return;
  }

  requestPending = true;

  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "Sending...";
    submitButton.setAttribute("aria-busy", "true");
  }

  try {
    const result =
      await signInWithEmailAndPassword(
        auth,
        email,
        password
      );

    if (result.user.emailVerified) {
      showMessage(
        "This email is already verified. You can return to sign in.",
        "success"
      );
      return;
    }

    await sendEmailVerification(
      result.user
    );

    showMessage(
      `Verification email sent to ${email}. Check your inbox and spam or junk folder.`,
      "success"
    );

    passwordInput.value = "";
  } catch (error) {
    console.error(
      "Failed to resend verification email:",
      error
    );

    showMessage(
      authenticationMessage(error)
    );
  } finally {
    try {
      await signOut(auth);
    } catch (signOutError) {
      console.error(
        "Failed to clear temporary verification session:",
        signOutError
      );
    }

    requestPending = false;

    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent =
        "Resend verification email";
      submitButton.removeAttribute("aria-busy");
    }
  }
});
