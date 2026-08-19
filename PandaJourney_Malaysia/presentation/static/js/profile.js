import {
  auth,
  db
} from "./firebase-config.js";

import {
  onAuthStateChanged,
  signOut,
  updateProfile
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

import {
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  query,
  where,
  getDocs,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";


// ================================
// Page Elements
// ================================

const identityName =
  document.querySelector(".identity-name");

const identityEmail =
  document.querySelector(".identity-email");

const editName =
  document.getElementById("edit-name");

const editEmail =
  document.getElementById("edit-email");

const avatarLetter =
  document.getElementById("avatar-letter");

const avatarEditBtn =
  document.getElementById("avatar-edit-btn");

const avatarPicker =
  document.getElementById("avatar-picker");

const closeAvatarPicker =
  document.getElementById("close-avatar-picker");

const avatarOptions =
  document.querySelectorAll(".avatar-option");

const interestHint =
  document.getElementById("interest-hint");

const FAVOURITES_COLLECTION = "Favourites";

// ================================
// Current / Original Values
// ================================

let selectedAvatar = "";

let originalDisplayName = "";
let originalAvatar = "";
let originalInterests = [];

let isEditing = false;


// ================================
// Load Current User
// ================================

onAuthStateChanged(auth, async (user) => {

  if (!user) {

    console.log("No user logged in.");

    window.location.href = "/";
    return;
  }


  console.log("Logged in user:", user.uid);


  // ================================
  // Firebase Auth Basic Information
  // ================================

  const authName =
    user.displayName ||
    user.email?.split("@")[0] ||
    "";


  if (identityName) {
    identityName.textContent =
      authName;
  }


  if (identityEmail) {
    identityEmail.textContent =
      user.email || "";
  }


  if (editName) {
    editName.value =
      authName;
  }


  if (editEmail) {
    editEmail.value =
      user.email || "";
  }


  originalDisplayName =
    authName;


  // Default avatar = first letter
  if (avatarLetter) {

    avatarLetter.textContent =
      authName
        .charAt(0)
        .toUpperCase();

  }

// ================================
// Favourite Attractions
// ================================

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}

async function loadFavourites(user) {

    const loadingEl = document.getElementById("fav-loading");
    const listEl = document.getElementById("fav-list");
    const emptyEl = document.getElementById("fav-empty");
    const countEl = document.getElementById("fav-count-stat");

    try {

        const favouritesQuery = query(
            collection(db, FAVOURITES_COLLECTION),
            where("user_id", "==", user.uid)
        );

        const snapshot = await getDocs(favouritesQuery);

        if (loadingEl) loadingEl.style.display = "none";

        if (countEl) countEl.textContent = `${snapshot.size}`;

        if (snapshot.empty) {
            if (listEl) listEl.style.display = "none";
            if (emptyEl) emptyEl.style.display = "block";
            return;
        }

        if (emptyEl) emptyEl.style.display = "none";
        if (!listEl) return;

        listEl.style.display = "block";
        listEl.innerHTML = "";

        snapshot.forEach((docSnap) => {
            const data = docSnap.data();

            const row = document.createElement("div");
            row.className = "fav-row";

            row.innerHTML = `
                <div class="recent-icon">⭐</div>
                <div class="fav-row-name">${escapeHtml(data.name)}</div>
                <button class="fav-remove" type="button">Remove</button>
            `;

            row.querySelector(".fav-remove").addEventListener("click", () => {
                removeFavourite(docSnap.id, user);
            });

            listEl.appendChild(row);
        });

    } catch (error) {

        console.error("Failed to load favourites:", error);

        if (loadingEl) loadingEl.style.display = "none";
        if (emptyEl) emptyEl.style.display = "block";
    }
}

async function removeFavourite(documentId, user) {

    try {

        await deleteDoc(doc(db, FAVOURITES_COLLECTION, documentId));

        await loadFavourites(user);

    } catch (error) {

        console.error("Failed to remove favourite:", error);
    }
}

  // ================================
  // Get Firestore User Profile
  // ================================

  try {

    const userRef =
      doc(
        db,
        "users",
        user.uid
      );


    const userSnap =
      await getDoc(userRef);


    if (userSnap.exists()) {

      const data =
        userSnap.data();


      console.log(
        "Firestore profile:",
        data
      );


      // ================================
      // Display Name
      // ================================

      if (data.displayName) {

        if (identityName) {
          identityName.textContent =
            data.displayName;
        }


        if (editName) {
          editName.value =
            data.displayName;
        }


        originalDisplayName =
          data.displayName;

      }


      // ================================
      // Email
      // ================================

      if (data.email) {

        if (identityEmail) {
          identityEmail.textContent =
            data.email;
        }


        if (editEmail) {
          editEmail.value =
            data.email;
        }

      }


      // ================================
      // Avatar
      // ================================

      if (data.avatar) {

        selectedAvatar =
          data.avatar;

        originalAvatar =
          data.avatar;


        if (avatarLetter) {

          avatarLetter.textContent =
            data.avatar;

        }

      } else {

        selectedAvatar = "";
        originalAvatar = "";


        if (avatarLetter) {

          avatarLetter.textContent =
            (
              data.displayName ||
              authName
            )
              .charAt(0)
              .toUpperCase();

        }

      }


      // ================================
      // Interests
      // ================================

      const interests =
        data.interests || [];


      originalInterests =
        [...interests];


      document
        .querySelectorAll(".interest-chip")
        .forEach(chip => {

            const isSelected =
            originalInterests.includes(
                chip.dataset.interest
            );

            chip.classList.toggle(
            "active",
            isSelected
            );

            chip.setAttribute(
            "aria-pressed",
            isSelected ? "true" : "false"
            );

        });

    }

  }
  catch (error) {

    console.error(
      "Error loading Firestore profile:",
      error
    );

  }

});


// ================================
// Toggle Edit Mode
// ================================

window.toggleEdit =
function () {

  const identityView =
    document.getElementById(
      "identity-view"
    );

  const identityEdit =
    document.getElementById(
      "identity-edit"
    );

  const editActions =
    document.getElementById(
      "edit-actions"
    );

  const editButton =
    document.getElementById(
      "edit-toggle-btn"
    );


  if (identityView) {
    identityView.style.display =
      "none";
  }


  if (identityEdit) {
    identityEdit.style.display =
      "flex";
  }


  if (editActions) {
    editActions
      .classList
      .remove("hidden");
  }


  if (editButton) {
    editButton.style.display =
      "none";
  }


  // ================================
  // Avatar Editing
  // ================================

  if (avatarEditBtn) {

    avatarEditBtn
      .classList
      .remove("hidden");

  }


  // ================================
  // Interest Editing
  // ================================

  isEditing = true;


  document
    .querySelectorAll(
      ".interest-chip"
    )
    .forEach(chip => {

      chip
        .classList
        .add("editable");

    });


  if (interestHint) {

    interestHint.textContent =
      "Select the interests that describe you.";

  }

};


// ================================
// Avatar Picker
// ================================

if (avatarEditBtn) {

  avatarEditBtn.addEventListener(
    "click",
    () => {

      if (avatarPicker) {

        avatarPicker
          .classList
          .toggle("hidden");

      }

    }
  );

}


// ================================
// Close Avatar Picker
// ================================

if (closeAvatarPicker) {

  closeAvatarPicker.addEventListener(
    "click",
    () => {

      if (avatarPicker) {

        avatarPicker
          .classList
          .add("hidden");

      }

    }
  );

}


// ================================
// Select Avatar
// ================================

avatarOptions.forEach(option => {

  option.addEventListener(
    "click",
    () => {

      selectedAvatar =
        option.dataset.avatar || "";


      // Remove previous selected style
      avatarOptions.forEach(item => {

        item
          .classList
          .remove("selected");

      });


      // Highlight selected avatar
      option
        .classList
        .add("selected");


      // Preview avatar
      if (avatarLetter) {

        avatarLetter.textContent =
          selectedAvatar;

      }


      // Close picker
      if (avatarPicker) {

        avatarPicker
          .classList
          .add("hidden");

      }

    }
  );

});


// ================================
// Interest Chip Click
// ================================

document
  .querySelectorAll(".interest-chip")
  .forEach(chip => {

    chip.addEventListener("click", () => {

      // Normal Profile mode
      if (!isEditing) {
        return;
      }

      chip.classList.toggle("active");

      chip.setAttribute(
        "aria-pressed",
        chip.classList.contains("active")
          ? "true"
          : "false"
      );

    });

  });


// ================================
// Cancel Edit
// ================================

window.cancelEdit =
function () {

  // ================================
  // Restore Name
  // ================================

  if (editName) {

    editName.value =
      originalDisplayName;

  }


  // ================================
  // Restore Avatar
  // ================================

  selectedAvatar =
    originalAvatar;


  if (avatarLetter) {

    if (originalAvatar) {

      avatarLetter.textContent =
        originalAvatar;

    } else {

      avatarLetter.textContent =
        originalDisplayName
          .charAt(0)
          .toUpperCase();

    }

  }


  // ================================
  // Restore Interests
  // ================================

  document
  .querySelectorAll(".interest-chip")
  .forEach(chip => {

    const isSelected =
      interests.includes(
        chip.dataset.interest
      );

    chip.classList.toggle(
      "active",
      isSelected
    );

    chip.setAttribute(
      "aria-pressed",
      isSelected ? "true" : "false"
    );

  });


  // ================================
  // Close Avatar Picker
  // ================================

  if (avatarPicker) {

    avatarPicker
      .classList
      .add("hidden");

  }


  // ================================
  // Hide Avatar Edit Button
  // ================================

  if (avatarEditBtn) {

    avatarEditBtn
      .classList
      .add("hidden");

  }


  // ================================
  // Lock Interests
  // ================================

  isEditing = false;


  document
    .querySelectorAll(
      ".interest-chip"
    )
    .forEach(chip => {

      chip
        .classList
        .remove("editable");

    });


  if (interestHint) {

    interestHint.textContent =
      "Click Edit Profile to update your interests.";

  }


  // ================================
  // Back to View Mode
  // ================================

  const identityView =
    document.getElementById(
      "identity-view"
    );

  const identityEdit =
    document.getElementById(
      "identity-edit"
    );

  const editActions =
    document.getElementById(
      "edit-actions"
    );

  const editButton =
    document.getElementById(
      "edit-toggle-btn"
    );


  if (identityView) {
    identityView.style.display =
      "block";
  }


  if (identityEdit) {
    identityEdit.style.display =
      "none";
  }


  if (editActions) {

    editActions
      .classList
      .add("hidden");

  }


  if (editButton) {

    editButton.style.display =
      "inline-flex";

  }

};


// ================================
// Save Profile
// ================================

window.saveProfile =
async function () {

  const user =
    auth.currentUser;


  if (!user) {

    alert(
      "You are not logged in."
    );

    return;

  }


  const newDisplayName =
    editName
      ?.value
      .trim() || "";


  if (!newDisplayName) {

    alert(
      "Display name cannot be empty."
    );

    return;

  }


  // ================================
  // Selected Interests
  // ================================

    const selectedInterests =
    Array
        .from(
        document.querySelectorAll(
            ".interest-chip.active"
        )
        )
        .map(
        chip => chip.dataset.interest
        );


  // ================================
  // User Data
  // ================================

  const userData = {

    displayName:
      newDisplayName,

    email:
      user.email || "",

    photoURL:
      user.photoURL || "",

    avatar:
      selectedAvatar,

    interests:
      selectedInterests,

    updatedAt:
      serverTimestamp()

  };


  try {

    // ================================
    // Update Firebase Auth
    // ================================

    await updateProfile(
      user,
      {
        displayName:
          newDisplayName
      }
    );


    // ================================
    // Update Firestore
    // ================================

    const userRef =
      doc(
        db,
        "users",
        user.uid
      );


    await setDoc(
      userRef,
      userData,
      {
        merge: true
      }
    );


    console.log(
      "Profile saved successfully"
    );


    // ================================
    // Update Display Name
    // ================================

    if (identityName) {

      identityName.textContent =
        newDisplayName;

    }


    if (editName) {

      editName.value =
        newDisplayName;

    }


    // ================================
    // Remember Saved Values
    // ================================

    originalDisplayName =
      newDisplayName;

    originalAvatar =
      selectedAvatar;

    originalInterests =
      [...selectedInterests];


    // ================================
    // Update Avatar
    // ================================

    if (avatarLetter) {

      if (selectedAvatar) {

        avatarLetter.textContent =
          selectedAvatar;

      } else {

        avatarLetter.textContent =
          newDisplayName
            .charAt(0)
            .toUpperCase();

      }

    }


    // ================================
    // Lock Interests
    // ================================

    isEditing = false;


    document
      .querySelectorAll(
        ".interest-chip"
      )
      .forEach(chip => {

        chip
          .classList
          .remove("editable");

      });


    if (interestHint) {

      interestHint.textContent =
        "Click Edit Profile to update your interests.";

    }


    // ================================
    // Show Toast
    // ================================

    const toast =
      document.getElementById(
        "save-toast"
      );


    if (toast) {

      toast
        .classList
        .add("show");


      setTimeout(
        () => {

          toast
            .classList
            .remove("show");

        },
        2500
      );

    }


    // ================================
    // Exit Edit Mode
    // ================================

    const identityView =
      document.getElementById(
        "identity-view"
      );

    const identityEdit =
      document.getElementById(
        "identity-edit"
      );

    const editActions =
      document.getElementById(
        "edit-actions"
      );

    const editButton =
      document.getElementById(
        "edit-toggle-btn"
      );


    if (identityView) {

      identityView.style.display =
        "block";

    }


    if (identityEdit) {

      identityEdit.style.display =
        "none";

    }


    if (editActions) {

      editActions
        .classList
        .add("hidden");

    }


    if (editButton) {

      editButton.style.display =
        "inline-flex";

    }


    // ================================
    // Hide Avatar Controls
    // ================================

    if (avatarEditBtn) {

      avatarEditBtn
        .classList
        .add("hidden");

    }


    if (avatarPicker) {

      avatarPicker
        .classList
        .add("hidden");

    }

  }
  catch (error) {

    console.error(
      "Error saving profile:",
      error
    );


    alert(
      "Failed to save profile."
    );

  }

};


// ================================
// Logout
// ================================

window.confirmLogout =
async function () {

  const confirmed =
    confirm(
      "Are you sure you want to sign out?"
    );


  if (!confirmed) {
    return;
  }


  try {

    await signOut(auth);


    window.location.href =
      "/";

  }
  catch (error) {

    console.error(
      "Logout failed:",
      error
    );

  }

};