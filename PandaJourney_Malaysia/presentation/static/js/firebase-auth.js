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
  signOut
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

provider.setCustomParameters({
  prompt: "select_account"
});

// Google Login
const googleLogin = document.getElementById("googleLogin");

if (googleLogin) {
  googleLogin.addEventListener("click", async () => {
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

            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp()
        });

    } else {

        await setDoc(userRef, {
            updatedAt: serverTimestamp()
        }, { merge: true });

    }

      console.log("User saved to Firestore!");

      window.location.href = "/profile";

    } catch (error) {
      console.error("Google Login failed:", error);
      alert(error.message);
    }
  });
}

// Google Sign Up
const googleSignup = document.getElementById("googleSignup");

if (googleSignup) {
  googleSignup.addEventListener("click", async () => {
    try {
      const result = await signInWithPopup(auth, provider);
      const user = result.user;

      console.log("Google Sign Up successful!");
      console.log("Name:", user.displayName);
      console.log("Email:", user.email);
      console.log("UID:", user.uid);

      await setDoc(
        doc(db, "users", user.uid),
        {
          uid: user.uid,
          email: user.email,
          displayName: user.displayName || "",
          profilePictureUrl: user.photoURL || null,
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );

      console.log("User saved to Firestore!");

      window.location.href = "/profile";

    } catch (error) {
      console.error("Google Sign Up failed:", error);
      alert(error.message);
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

if (loginForm && document.getElementById("email")) {
  if (!document.getElementById("registerForm")) {
    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();

      const email = document.getElementById("email").value.trim();
      const password = document.getElementById("password").value;

      try {
        const result = await signInWithEmailAndPassword(
          auth,
          email,
          password
        );

        const user = result.user;

        if (!user.emailVerified) {

            await signOut(auth);

            alert(
              "Please verify your email before logging in."
            );

            return;
        }

        console.log("Email Login successful!");
        console.log("UID:", user.uid);

        await setDoc(
          doc(db, "users", user.uid),
          {
            uid: user.uid,
            email: user.email,
            displayName: user.displayName || "",
            profilePictureUrl: user.photoURL || null,
            updatedAt: serverTimestamp()
          },
          { merge: true }
        );

        window.location.href = "/profile";

      } catch (error) {
        console.error("Email Login failed:", error);
        alert(error.message);
      }
    });
  }
}

// Email Create Account
const registerForm = document.getElementById("registerForm");

if (registerForm) {
  registerForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const name = document.getElementById("name").value.trim();
    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    const confirmPassword = document.getElementById("confirmPassword").value;

    const errorBox = document.getElementById("registerError");
    const button = document.getElementById("createAccountBtn");

    errorBox.style.display = "none";
    errorBox.textContent = "";

    if (password !== confirmPassword) {
      errorBox.textContent = "Passwords do not match.";
      errorBox.style.display = "block";
      return;
    }

    if (password.length < 8) {
      errorBox.textContent = "Password must be at least 8 characters.";
      errorBox.style.display = "block";
      return;
    }

    try {
      button.disabled = true;
      button.textContent = "Creating Account...";

      const result = await createUserWithEmailAndPassword(
        auth,
        email,
        password
      );

      const user = result.user;

      console.log("Account created!");
      console.log("UID:", user.uid);

      await updateProfile(user, {
        displayName: name
      });

      await sendEmailVerification(user);

      await setDoc(
        doc(db, "users", user.uid),
        {
          uid: user.uid,
          email: user.email,
          displayName: name,
          profilePictureUrl: null,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        },
        { merge: true }
      );

      alert(
        "Account created successfully!\n\nPlease check your email and click the verification link before logging in."
      );

      window.location.href = "/";

    } catch (error) {
      console.error("Create Account failed:", error);

      if (error.code === "auth/email-already-in-use") {
        errorBox.textContent = "An account with this email already exists.";
      } else if (error.code === "auth/invalid-email") {
        errorBox.textContent = "Please enter a valid email address.";
      } else if (error.code === "auth/weak-password") {
        errorBox.textContent = "Password is too weak.";
      } else {
        errorBox.textContent = error.message;
      }

      errorBox.style.display = "block";

      button.disabled = false;
      button.textContent = "Create Account";
    }
  });
}

async function linkEmailPassword(email, password) {

    const user = auth.currentUser;

    if (!user) {
        alert("Please login first.");
        return;
    }

    try {

        const credential =
            EmailAuthProvider.credential(
                email,
                password
            );

        await linkWithCredential(
            user,
            credential
        );

        console.log(
            "Email/Password linked successfully!"
        );

        alert(
            "Email and password have been linked to your Google account."
        );

    } catch (error) {

        console.error(
            "Failed to link Email/Password:",
            error
        );

        if (
            error.code ===
            "auth/provider-already-linked"
        ) {

            alert(
                "This account already has Email/Password login."
            );

        } else if (
            error.code ===
            "auth/email-already-in-use"
        ) {

            alert(
                "This email is already connected to another Firebase account."
            );

        } else {

            alert(error.message);

        }
    }
}