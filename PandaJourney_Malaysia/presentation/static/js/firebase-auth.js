import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";

// Firebase Authentication
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  updateProfile,
  sendEmailVerification,
  linkWithCredential,
  EmailAuthProvider,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

// Firebase Firestore
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  serverTimestamp
}
from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

// Firebase Configuration
const firebaseConfig = {
  apiKey: "AIzaSyAX3NQdMKHFGwoySHcNAYW8dHFSnZBo_MI",
  authDomain: "pandajourney-ef50a.firebaseapp.com",
  projectId: "pandajourney-ef50a",
  storageBucket: "pandajourney-ef50a.firebasestorage.app",
  messagingSenderId: "725150303645",
  appId: "1:725150303645:web:5a0254ed334923d607db74",
  measurementId: "G-5XDDN834ZQ"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const provider = new GoogleAuthProvider();

function getPasswordRules(password) {
  return {
    length: password.length >= 8,
    uppercase: /[A-Z]/.test(password),
    lowercase: /[a-z]/.test(password),
    special: /[^A-Za-z0-9]/.test(password)
  };
}

function updateRegistrationPasswordGuidance() {
  const password = document.getElementById("password")?.value || "";
  const confirmation = document.getElementById("confirmPassword")?.value || "";
  const rules = getPasswordRules(password);

  document
    .querySelectorAll("[data-register-password-rule]")
    .forEach(element => {
      element.classList.toggle(
        "met",
        Boolean(rules[element.dataset.registerPasswordRule])
      );
    });

  const matchElement = document.getElementById("register-password-match");
  if (!matchElement) return;

  if (!confirmation) {
    matchElement.textContent = "";
    matchElement.className = "auth-password-match";
  } else if (password === confirmation) {
    matchElement.textContent = "✓ Passwords match";
    matchElement.className = "auth-password-match match";
  } else {
    matchElement.textContent = "Passwords do not match";
    matchElement.className = "auth-password-match mismatch";
  }
}

document.querySelectorAll("[data-password-target]").forEach(button => {
  button.addEventListener("click", () => {
    const input = document.getElementById(button.dataset.passwordTarget);
    if (!input) return;
    const willShow = input.type === "password";
    input.type = willShow ? "text" : "password";
    button.textContent = willShow ? "Hide" : "Show";
    button.setAttribute("aria-label", `${willShow ? "Hide" : "Show"} password`);
  });
});

document.getElementById("password")?.addEventListener(
  "input",
  updateRegistrationPasswordGuidance
);
document.getElementById("confirmPassword")?.addEventListener(
  "input",
  updateRegistrationPasswordGuidance
);

async function createServerSession(user) {
  const idToken = await user.getIdToken(true);

  const response = await fetch(
    "/session-login",
    {
      method: "POST",
      credentials: "same-origin",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        idToken
      })
    }
  );

  const payload = await response
    .json()
    .catch(() => ({}));

  if (!response.ok) {
    const error = new Error(
      payload.error ||
      "Unable to establish a secure session."
    );

    error.code = "auth/server-session-failed";
    throw error;
  }
}


function getSafeLoginDestination() {
  const requested =
    new URLSearchParams(
      window.location.search
    ).get("next");

  if (
    requested &&
    requested.startsWith("/") &&
    !requested.startsWith("//")
  ) {
    return requested;
  }

  return "/profile";
}

provider.setCustomParameters({
  prompt: "select_account"
});

// Google Login
const googleLogin = document.getElementById("googleLogin");
let googleLoginPending = false;

if (googleLogin) {
  googleLogin.addEventListener("click", async () => {
    if (googleLoginPending) {
      return;
    }

    googleLoginPending = true;
    googleLogin.disabled = true;
    googleLogin.setAttribute("aria-busy", "true");
    clearLoginError();
    try {
      const result = await signInWithPopup(auth, provider);
      const user = result.user;

      console.log("Google Login successful!");
      console.log("Name:", user.displayName);
      console.log("Email:", user.email);
      console.log("UID:", user.uid);
      
      const userRef = doc(db, "users", user.uid);
      const userSnap = await getDoc(userRef);

      if (!userSnap.exists()) {

        await setDoc(userRef, {
            uid: user.uid,
            email: user.email,
            displayName: user.displayName || "",
            profilePictureUrl: user.photoURL || null,
            authProvider: "google",

            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });

    } else {

        await setDoc(userRef, {
            authProvider: "google",
            profilePictureUrl: user.photoURL || null,
            updatedAt: serverTimestamp()
        }, { merge: true });

    }

      console.log("User saved to Firestore!");

      await createServerSession(user);

      localStorage.setItem(
      "pandajourney-authenticated",
      "true"
    );

      window.location.href = getSafeLoginDestination();

    } catch (error) {
      console.error("Google Login failed:", error);

      try {
        await signOut(auth);
      } catch (signOutError) {
        console.error("Failed to clear login session:", signOutError);
      }

      showLoginError(
        getAuthenticationErrorMessage(error)
      );
    } finally {
      googleLoginPending = false;
      googleLogin.disabled = false;
      googleLogin.removeAttribute("aria-busy");
    }
  });
}

// Google Sign Up
const googleSignup = document.getElementById("googleSignup");
let googleSignupPending = false;

if (googleSignup) {
  googleSignup.addEventListener("click", async () => {
    if (googleSignupPending) {
      return;
    }

    const agreeCheckbox = document.getElementById("agree");
    const registerError = document.getElementById("registerError");

    if (!agreeCheckbox?.checked) {
      if (registerError) {
        registerError.textContent =
          "Please agree to the Terms & Conditions and Privacy Policy.";
        registerError.style.display = "block";
      }

      agreeCheckbox?.focus();
      return;
    }

    googleSignupPending = true;
    googleSignup.disabled = true;
    googleSignup.setAttribute("aria-busy", "true");

    if (registerError) {
      registerError.textContent = "";
      registerError.style.display = "none";
    }

    try {
      const result = await signInWithPopup(auth, provider);
      const user = result.user;

      console.log("Google Sign Up successful!");
      console.log("Name:", user.displayName);
      console.log("Email:", user.email);
      console.log("UID:", user.uid);

      const userRef = doc(db, "users", user.uid);
      const userSnapshot = await getDoc(userRef);
      const googleProfile = {
        uid: user.uid,
        email: user.email,
        displayName: user.displayName || "",
        profilePictureUrl: user.photoURL || null,
        authProvider: "google",
        updatedAt: serverTimestamp()
      };

      if (!userSnapshot.exists()) {
        googleProfile.createdAt = serverTimestamp();
      }

      await setDoc(
        userRef,
        googleProfile,
        { merge: true }
      );

      console.log("User saved to Firestore!");
      await createServerSession(user);

      localStorage.setItem(
        "pandajourney-authenticated",
        "true"
      );
      window.location.href = getSafeLoginDestination();

    } catch (error) {
      console.error("Google Sign Up failed:", error);

      try {
        await signOut(auth);
      } catch (signOutError) {
        console.error("Failed to clear Google sign-up session:", signOutError);
      }

      if (registerError) {
        registerError.textContent =
          getAuthenticationErrorMessage(error);
        registerError.style.display = "block";
      }
    } finally {
      googleSignupPending = false;
      googleSignup.disabled = false;
      googleSignup.removeAttribute("aria-busy");
    }
  });
}

// Forgot Password
const forgotPasswordBtn =
  document.getElementById("forgotPasswordBtn");

const forgotPasswordMessage =
  document.getElementById("forgotPasswordMessage");

if (forgotPasswordBtn) {
  forgotPasswordBtn.addEventListener("click", async () => {
    if (forgotPasswordBtn.disabled) {
      return;
    }

    const emailInput = document.getElementById("email");
    const email = emailInput?.value.trim() || "";

    if (!email) {
      showForgotPasswordMessage(
        "Please enter your email address first.",
        "error"
      );

      emailInput?.focus();
      return;
    }

    if (!emailInput.checkValidity()) {
      showForgotPasswordMessage(
        "Please enter a valid email address.",
        "error"
      );

      emailInput.reportValidity();
      return;
    }

    try {
      forgotPasswordBtn.disabled = true;
      forgotPasswordBtn.textContent = "Sending...";

      auth.useDeviceLanguage();

      await sendPasswordResetEmail(auth, email);

      showForgotPasswordMessage(
        "If an account exists for this email, a password reset link has been sent. Please check your inbox and spam folder.",
        "success"
      );
    } catch (error) {
      console.error("Password reset failed:", error);

      let message =
        "Unable to send the reset email. Please try again.";

      if (error.code === "auth/invalid-email") {
        message = "Please enter a valid email address.";
      } else if (error.code === "auth/too-many-requests") {
        message =
          "Too many requests. Please wait a while and try again.";
      } else if (error.code === "auth/network-request-failed") {
        message =
          "Network error. Please check your connection and try again.";
      }

      showForgotPasswordMessage(message, "error");
    } finally {
      forgotPasswordBtn.disabled = false;
      forgotPasswordBtn.textContent = "Forgot password?";
    }
  });
}

function showForgotPasswordMessage(message, type) {
  if (!forgotPasswordMessage) {
    return;
  }

  forgotPasswordMessage.textContent = message;
  forgotPasswordMessage.className =
    `login-message ${type} show`;
}

// Email Login
const loginForm = document.querySelector(".login-form");
const loginSubmitButton =
  loginForm?.querySelector('button[type="submit"]');
let emailLoginPending = false;

if (loginForm && document.getElementById("email")) {
  if (!document.getElementById("registerForm")) {
    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      if (emailLoginPending) {
        return;
      }

      clearLoginError();

      const email =
        document.getElementById("email").value.trim();

      const password =
        document.getElementById("password").value;

      // M1: Email or password is missing
      if (!email || !password) {
        showLoginError(
          "Please enter your email address and password."
        );
        return;
      }

      if (!navigator.onLine) {
        showLoginError(
          "You are offline. Check your internet connection and try again."
        );
        return;
      }

      emailLoginPending = true;

      if (loginSubmitButton) {
        loginSubmitButton.disabled = true;
        loginSubmitButton.textContent = "Signing in...";
        loginSubmitButton.setAttribute("aria-busy", "true");
      }

      try {
        const result = await signInWithEmailAndPassword(
          auth,
          email,
          password
        );

        const user = result.user;

        if (!user.emailVerified) {
          let verificationResent = false;
          try {
            await sendEmailVerification(user);
            verificationResent = true;
          } catch (verificationError) {
            console.error("Unable to resend verification email:", verificationError);
          }

          await signOut(auth);

          showLoginError(
            verificationResent
              ? "Please verify your email before logging in. A new verification email has been sent."
              : "Please verify your email before logging in. We could not resend the email right now; please try again later."
          );

          return;
        }

        console.log("Email Login successful!");
        console.log("UID:", user.uid);

        const existingProfileSnapshot = await getDoc(
          doc(db, "users", user.uid)
        );
        const existingProfile = existingProfileSnapshot.exists()
          ? existingProfileSnapshot.data()
          : {};
        const loginProfile = {
          uid: user.uid,
          email: user.email,
          authProvider: "password",
          profilePictureUrl: null,
          updatedAt: serverTimestamp()
        };

        // A password login keeps any avatar selected inside PandaJourney.
        if (existingProfile.avatarType === "google") {
          loginProfile.avatarType = "";
          loginProfile.avatar = "";
          loginProfile.avatarUrl = "";
        }

        await setDoc(
          doc(db, "users", user.uid),
          loginProfile,
          { merge: true }
        );

        await createServerSession(user);

        localStorage.setItem(
          "pandajourney-authenticated",
          "true"
        );
        window.location.href = getSafeLoginDestination();

      } catch (error) {
        console.error("Email Login failed:", error);

        try {
          await signOut(auth);
        } catch (signOutError) {
          console.error("Failed to clear login session:", signOutError);
        }

        showLoginError(
          getAuthenticationErrorMessage(error)
        );
      } finally {
        emailLoginPending = false;

        if (loginSubmitButton) {
          loginSubmitButton.disabled = false;
          loginSubmitButton.textContent = "Sign in";
          loginSubmitButton.removeAttribute("aria-busy");
        }
      }
    });
  }
}

// Email Create Account
const registerForm = document.getElementById("registerForm");
let registrationPending = false;

if (registerForm) {
  registerForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (registrationPending) {
      return;
    }

    const name =
      document.getElementById("name").value.trim();

    const email =
      document.getElementById("email").value.trim();

    const password =
      document.getElementById("password").value;

    const confirmPassword =
      document.getElementById("confirmPassword").value;

    const agree =
      document.getElementById("agree");

    const errorBox =
      document.getElementById("registerError");

    const button =
      document.getElementById("createAccountBtn");

    // Clear the previous error message
    errorBox.textContent = "";
    errorBox.style.display = "none";

    // M1: Required fields are missing
    if (!name || !email || !password || !confirmPassword) {
      errorBox.textContent =
        "Please complete all required fields.";

      errorBox.style.display = "block";
      return;
    }

    if (Array.from(name).length > 100) {
      errorBox.textContent =
        "Full name must not exceed 100 characters.";

      errorBox.style.display = "block";
      document.getElementById("name")?.focus();
      return;
    }

    if (!agree?.checked) {
      errorBox.textContent =
        "Please agree to the Terms & Conditions and Privacy Policy.";

      errorBox.style.display = "block";
      agree?.focus();
      return;
    }

    if (!navigator.onLine) {
      errorBox.textContent =
        "You are offline. Check your internet connection and try again.";
      errorBox.style.display = "block";
      return;
    }

    // M2: Invalid email address
    const emailPattern =
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

    if (!emailPattern.test(email)) {
      errorBox.textContent =
        "Please enter a valid email address.";

      errorBox.style.display = "block";
      return;
    }

    // M3: Password is shorter than 8 characters and Not Strong
    const strongPassword =
      Object.values(getPasswordRules(password)).every(Boolean);

  if (!strongPassword) {
    errorBox.textContent =
      "Password must contain at least 8 characters, including uppercase, lowercase, and a special character.";

    errorBox.style.display = "block";
    return;
  }

    // M4: Password confirmation does not match
    if (password !== confirmPassword) {
      errorBox.textContent =
        "Passwords do not match.";

      errorBox.style.display = "block";
      return;
    }

    registrationPending = true;
    let createdEmailUser = null;

    try {
      button.disabled = true;
      button.setAttribute("aria-busy", "true");
      button.textContent = "Creating Account...";

      const result =
        await createUserWithEmailAndPassword(
          auth,
          email,
          password
        );

      const user = result.user;
      createdEmailUser = user;

      console.log("Account created!");
      console.log("UID:", user.uid);

      const setupResults = await Promise.allSettled([
        updateProfile(user, { displayName: name }),
        sendEmailVerification(user),
        setDoc(
          doc(db, "users", user.uid),
          {
            uid: user.uid,
            email: user.email,
            displayName: name,
            profilePictureUrl: null,
            authProvider: "password",
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
          },
          { merge: true }
        )
      ]);

      const verificationSent = setupResults[1].status === "fulfilled";
      const profileSaved = setupResults[2].status === "fulfilled";

      await signOut(auth);

      sessionStorage.setItem(
        "pandajourney-auth-message",
        verificationSent
          ? `Account created. Check your email and verify it before signing in.${profileSaved ? "" : " Your profile will be completed when you sign in."}`
          : "Account created, but the verification email could not be sent. Sign in again to resend it."
      );
      window.location.href = "/login";

    } catch (error) {
      console.error(
        "Create Account failed:",
        error
      );

      if (createdEmailUser) {
        try {
          await signOut(auth);
        } catch (signOutError) {
          console.error(
            "Failed to clear incomplete registration session:",
            signOutError
          );
        }
      }

      // M5: Email is already registered
      if (
        error.code ===
        "auth/email-already-in-use"
      ) {
        errorBox.textContent =
          "An account with this email address already exists.";

      // M2: Firebase rejects the email format
      } else if (
        error.code ===
        "auth/invalid-email"
      ) {
        errorBox.textContent =
          "Please enter a valid email address.";

      // M3: Firebase rejects the password
      } else if (
        error.code ===
        "auth/weak-password"
      ) {
        errorBox.textContent =
          "Passwords must contain at least 8 characters, including uppercase and lowercase letters and a special character.";

      // M6: Account or profile creation error
      } else {
        errorBox.textContent =
          window.PandaFeedback?.friendlyError(
            error,
            "Unable to create the account. Please try again."
          ) || "Unable to create the account. Please try again.";
      }

      errorBox.style.display = "block";

      registrationPending = false;
      button.disabled = false;
      button.removeAttribute("aria-busy");
      button.textContent = "Create Account";
    }
  });
}
function showLoginError(message) {
  const errorBox = document.getElementById("loginError");

  if (!errorBox) {
    console.error(message);
    return;
  }

  errorBox.textContent = message;
  errorBox.style.display = "block";
}

function clearLoginError() {
  const errorBox = document.getElementById("loginError");

  if (!errorBox) {
    return;
  }

  errorBox.textContent = "";
  errorBox.style.display = "none";
}

// Display the inactivity logout message
// after redirecting to the Login page.

const storedAuthenticationMessage =
  sessionStorage.getItem(
    "pandajourney-auth-message"
  );

if (storedAuthenticationMessage) {
  sessionStorage.removeItem(
    "pandajourney-auth-message"
  );

  showLoginError(
    storedAuthenticationMessage
  );
}

function getAuthenticationErrorMessage(error) {
  switch (error.code) {
    // M2: Invalid email address or password
    case "auth/invalid-email":
    case "auth/invalid-credential":
    case "auth/user-not-found":
    case "auth/wrong-password":
      return "Invalid email address or password.";

    case "auth/server-session-failed":
      return error.message ||
        "Unable to establish a secure session. Please try again.";

    case "auth/network-request-failed":
      return "Network error. Check your internet connection and try again.";

    case "auth/too-many-requests":
      return "Too many attempts. Please wait a while and try again.";

    case "auth/popup-blocked":
      return "The browser blocked the Google sign-in window. Allow pop-ups and try again.";

    // M3: Google sign-in was cancelled
    case "auth/popup-closed-by-user":
    case "auth/cancelled-popup-request":
      return "Google sign-in was cancelled.";

    // M4: Other authentication errors
    default:
      return error.message || "Unable to complete authentication.";
  }
}


let sessionRestorePending = false;

if (googleLogin) {
  onAuthStateChanged(auth, async user => {
    if (
      !user ||
      !user.emailVerified ||
      googleLoginPending ||
      emailLoginPending ||
      sessionRestorePending
    ) {
      return;
    }

    sessionRestorePending = true;
    clearLoginError();

    try {
      await createServerSession(user);
      localStorage.setItem("pandajourney-authenticated", "true");
      window.location.replace(getSafeLoginDestination());
    } catch (error) {
      showLoginError(getAuthenticationErrorMessage(error));
      sessionRestorePending = false;
    }
  });
}
