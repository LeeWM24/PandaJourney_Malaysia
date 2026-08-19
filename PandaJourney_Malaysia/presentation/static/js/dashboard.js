import {
  auth,
  db
} from "./firebase-config.js";

import {
  doc,
  getDoc
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";


onAuthStateChanged(auth, async (user) => {

  if (!user) {
    console.log("No Firebase user logged in.");
    return;
  }

  console.log("Dashboard user:", user);


  // =========================
  // Default Auth Data
  // =========================

  let name =
    user.displayName ||
    user.email?.split("@")[0] ||
    "";

  let customAvatar = "";


  // =========================
  // Read Firestore Profile
  // =========================

  try {

    const userRef =
      doc(db, "users", user.uid);

    const userSnap =
      await getDoc(userRef);

    if (userSnap.exists()) {

      const data =
        userSnap.data();

      console.log(
        "Dashboard Firestore profile:",
        data
      );


      // Prefer Firestore display name
      if (data.displayName) {
        name = data.displayName;
      }


      // Custom avatar from Profile page
      if (data.avatar) {
        customAvatar = data.avatar;
      }

    }

  }
  catch (error) {

    console.error(
      "Error loading dashboard profile:",
      error
    );

  }


  // =========================
  // User Name
  // =========================

  const dashboardName =
    document.getElementById(
      "dashboardName"
    );

  const heroName =
    document.getElementById(
      "heroName"
    );

  const heroUserName =
    document.getElementById(
      "heroUserName"
    );


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
    document.getElementById(
      "heroUserEmail"
    );

  if (heroUserEmail) {
    heroUserEmail.textContent =
      user.email || "";
  }


  // =========================
  // Profile Picture
  // =========================

  const avatarImage =
    document.getElementById(
      "avatarImage"
    );

  const avatarInitials =
    document.getElementById(
      "avatarInitials"
    );


  // 1. Custom avatar from Firestore
  if (customAvatar) {

    if (avatarInitials) {

      avatarInitials.textContent =
        customAvatar;

      avatarInitials.style.display =
        "flex";

    }

    if (avatarImage) {

      avatarImage.style.display =
        "none";

    }

  }

  // 2. Google profile picture
  else if (user.photoURL) {

    if (avatarImage) {

      avatarImage.src =
        user.photoURL;

      avatarImage.style.display =
        "block";

    }

    if (avatarInitials) {

      avatarInitials.style.display =
        "none";

    }

  }

  // 3. First letter fallback
  else {

    if (avatarInitials) {

      avatarInitials.textContent =
        name.charAt(0).toUpperCase();

      avatarInitials.style.display =
        "flex";

    }

    if (avatarImage) {

      avatarImage.style.display =
        "none";

    }

  }

});