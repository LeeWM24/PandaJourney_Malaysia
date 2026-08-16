import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";

import {
  getAuth,
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyAX3NQdMKHFGwoySHcNAYW8dHFSnZBo_MI",
  authDomain: "pandajourney-ef50a.firebaseapp.com",
  projectId: "pandajourney-ef50a",
  storageBucket: "pandajourney-ef50a.firebasestorage.app",
  messagingSenderId: "725150303645",
  appId: "1:725150303645:web:5a0254ed334923d607db74",
  measurementId: "G-5XDDN834ZQ"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

onAuthStateChanged(auth, (user) => {

  if (!user) {
    console.log("No Firebase user logged in.");
    return;
  }

  console.log("Dashboard user:", user);

  // =========================
  // User Name
  // =========================

  const name =
    user.displayName ||
    user.email?.split("@")[0] ||
    "User";

  const dashboardName =
    document.getElementById("dashboardName");

  const heroName =
    document.getElementById("heroName");

  const heroUserName =
    document.getElementById("heroUserName");

  if (dashboardName) {
    dashboardName.textContent = name;
  }

  if (heroName) {
    heroName.textContent = name;
  }

  if (heroUserName) {
    heroUserName.textContent = name;
  }


  // =========================
  // Email
  // =========================

  const heroUserEmail =
    document.getElementById("heroUserEmail");

  if (heroUserEmail) {
    heroUserEmail.textContent = user.email || "";
  }


  // =========================
  // Profile Picture
  // =========================

  const avatarImage =
    document.getElementById("avatarImage");

  const avatarInitials =
    document.getElementById("avatarInitials");

  if (user.photoURL) {

    avatarImage.src = user.photoURL;
    avatarImage.style.display = "block";

    if (avatarInitials) {
      avatarInitials.style.display = "none";
    }

  } else {

    if (avatarInitials) {
      avatarInitials.textContent =
        name.substring(0, 2).toUpperCase();

      avatarInitials.style.display = "flex";
    }

    if (avatarImage) {
      avatarImage.style.display = "none";
    }
  }

});