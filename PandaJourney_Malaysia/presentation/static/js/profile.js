import {
  auth,
  db,
  storage
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
  deleteDoc,
  collection,
  query,
  where,
  getDocs,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

import {
  ref,
  uploadBytes,
  getDownloadURL
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-storage.js";


// Elements

const identityName = document.querySelector(".identity-name");
const identityEmail = document.querySelector(".identity-email");
const editName = document.getElementById("edit-name");
const editEmail = document.getElementById("edit-email");

const avatarImage = document.getElementById("avatar-image");
const avatarLetter = document.getElementById("avatar-letter");
const avatarEditBtn = document.getElementById("avatar-edit-btn");
const avatarPicker = document.getElementById("avatar-picker");
const closeAvatarPicker = document.getElementById("close-avatar-picker");
const avatarOptions = document.querySelectorAll(".avatar-option");
const useGoogleAvatarBtn = document.getElementById("use-google-avatar");
const uploadAvatarBtn = document.getElementById("upload-avatar-btn");
const avatarFileInput = document.getElementById("avatar-file-input");

const interestHint = document.getElementById("interest-hint");

const FAVOURITES_COLLECTION = "Favourites";


// State

let isEditing = false;

let selectedAvatarType = "";
let selectedAvatar = "";
let selectedAvatarUrl = "";
let selectedAvatarFile = null;
let previewObjectUrl = null;

let originalDisplayName = "";
let originalAvatarType = "";
let originalAvatar = "";
let originalAvatarUrl = "";
let originalInterests = [];


// Avatar Renderer

function renderAvatar({
  type = "",
  emoji = "",
  uploadUrl = "",
  googleUrl = "",
  name = ""
}) {
  if (!avatarImage || !avatarLetter) {
    return;
  }

  if (type === "upload" && uploadUrl) {
    avatarImage.src = uploadUrl;
    avatarImage.style.display = "block";
    avatarLetter.style.display = "none";
    return;
  }

  if (type === "google" && googleUrl) {
    avatarImage.src = googleUrl;
    avatarImage.style.display = "block";
    avatarLetter.style.display = "none";
    return;
  }

  if (type === "emoji" && emoji) {
    avatarImage.style.display = "none";
    avatarLetter.style.display = "flex";
    avatarLetter.textContent = emoji;
    return;
  }

  if (googleUrl) {
    avatarImage.src = googleUrl;
    avatarImage.style.display = "block";
    avatarLetter.style.display = "none";
    return;
  }

  avatarImage.style.display = "none";
  avatarLetter.style.display = "flex";
  avatarLetter.textContent = name.charAt(0).toUpperCase();
}


// Avatar Selected Style

function updateAvatarSelectedStyle() {
  avatarOptions.forEach(option => {
    const isSelected =
      selectedAvatarType === "emoji" &&
      option.dataset.avatar === selectedAvatar;

    option.classList.toggle("selected", isSelected);
  });
}


// Restore Avatar

function restoreOriginalAvatar() {
  selectedAvatarType = originalAvatarType;
  selectedAvatar = originalAvatar;
  selectedAvatarUrl = originalAvatarUrl;
  selectedAvatarFile = null;

  if (previewObjectUrl) {
    URL.revokeObjectURL(previewObjectUrl);
    previewObjectUrl = null;
  }

  renderAvatar({
    type: originalAvatarType,
    emoji: originalAvatar,
    uploadUrl: originalAvatarUrl,
    googleUrl: auth.currentUser?.photoURL || "",
    name: originalDisplayName
  });

  updateAvatarSelectedStyle();
}


// Firebase User

onAuthStateChanged(auth, async user => {
  if (!user) {
    console.log("No user logged in.");
    window.location.href = "/";
    return;
  }

  console.log("Logged in user:", user.uid);

  const authName =
    user.displayName ||
    user.email?.split("@")[0] ||
    "";

  originalDisplayName = authName;

  if (identityName) {
    identityName.textContent = authName;
  }

  if (identityEmail) {
    identityEmail.textContent = user.email || "";
  }

  if (editName) {
    editName.value = authName;
  }

  if (editEmail) {
    editEmail.value = user.email || "";
  }

  renderAvatar({
    googleUrl: user.photoURL || "",
    name: authName
  });

  // Firestore Profile

  try {
    const userRef = doc(db, "users", user.uid);
    const snapshot = await getDoc(userRef);

    if (snapshot.exists()) {
      const data = snapshot.data();

      console.log("Firestore profile:", data);

      if (data.displayName) {
        originalDisplayName = data.displayName;
        identityName.textContent = data.displayName;
        editName.value = data.displayName;
      }

      if (data.email) {
        identityEmail.textContent = data.email;
        editEmail.value = data.email;
      }

      // Avatar Loading

      let storedType = data.avatarType || "";

      if (!storedType && data.avatar) {
        storedType = "emoji";
      }

      if (!storedType && user.photoURL) {
        storedType = "google";
      }

      originalAvatarType = storedType;
      originalAvatar = data.avatar || "";
      originalAvatarUrl = data.avatarUrl || "";

      selectedAvatarType = originalAvatarType;
      selectedAvatar = originalAvatar;
      selectedAvatarUrl = originalAvatarUrl;

      renderAvatar({
        type: selectedAvatarType,
        emoji: selectedAvatar,
        uploadUrl: selectedAvatarUrl,
        googleUrl: user.photoURL || "",
        name: originalDisplayName
      });

      updateAvatarSelectedStyle();

      // Interests

      originalInterests = Array.isArray(data.interests)
        ? [...data.interests]
        : [];

      document.querySelectorAll(".interest-chip").forEach(chip => {
        const selected = originalInterests.includes(chip.dataset.interest);

        chip.classList.toggle("active", selected);
        chip.setAttribute("aria-pressed", selected ? "true" : "false");
      });
    }

    await loadFavourites(user);
    await loadSavedItineraryCount(user);
  } catch (error) {
    console.error("Failed to load profile:", error);
  }
});


// Edit Profile

window.toggleEdit = function () {
  isEditing = true;

  const identityView = document.getElementById("identity-view");
  const identityEdit = document.getElementById("identity-edit");
  const editActions = document.getElementById("edit-actions");
  const editButton = document.getElementById("edit-toggle-btn");

  if (identityView) {
    identityView.style.display = "none";
  }

  if (identityEdit) {
    identityEdit.style.display = "flex";
  }

  if (editActions) {
    editActions.classList.remove("hidden");
  }

  if (editButton) {
    editButton.style.display = "none";
  }

  if (avatarEditBtn) {
    avatarEditBtn.classList.remove("hidden");
  }

  document.querySelectorAll(".interest-chip").forEach(chip => {
    chip.classList.add("editable");
  });

  if (interestHint) {
    interestHint.textContent = "Select the interests that describe you.";
  }
};


// Open Avatar Picker

if (avatarEditBtn) {
  avatarEditBtn.addEventListener("click", () => {
    if (!isEditing) {
      return;
    }

    avatarPicker?.classList.toggle("hidden");
  });
}


// Close Avatar Picker

if (closeAvatarPicker) {
  closeAvatarPicker.addEventListener("click", () => {
    avatarPicker?.classList.add("hidden");
  });
}


// Google Avatar

if (useGoogleAvatarBtn) {
  useGoogleAvatarBtn.addEventListener("click", () => {
    if (!isEditing) {
      return;
    }

    const user = auth.currentUser;

    if (!user?.photoURL) {
      alert("No Google profile photo is available for this account.");
      return;
    }

    selectedAvatarType = "google";
    selectedAvatar = "";
    selectedAvatarUrl = "";
    selectedAvatarFile = null;

    renderAvatar({
      type: "google",
      googleUrl: user.photoURL,
      name: editName?.value || ""
    });

    updateAvatarSelectedStyle();
    avatarPicker?.classList.add("hidden");
  });
}


// Upload Button

if (uploadAvatarBtn) {
  uploadAvatarBtn.addEventListener("click", () => {
    if (!isEditing) {
      return;
    }

    avatarFileInput?.click();
  });
}


// Upload Preview

if (avatarFileInput) {
  avatarFileInput.addEventListener("change", () => {
    const file = avatarFileInput.files?.[0];

    if (!file) {
      return;
    }

    const allowedTypes = [
      "image/jpeg",
      "image/png",
      "image/webp"
    ];

    if (!allowedTypes.includes(file.type)) {
      alert("Please choose a JPG, PNG, or WebP image.");
      avatarFileInput.value = "";
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      alert("Profile picture must be smaller than 2 MB.");
      avatarFileInput.value = "";
      return;
    }

    selectedAvatarFile = file;
    selectedAvatarType = "upload";
    selectedAvatar = "";

    if (previewObjectUrl) {
      URL.revokeObjectURL(previewObjectUrl);
    }

    previewObjectUrl = URL.createObjectURL(file);

    renderAvatar({
      type: "upload",
      uploadUrl: previewObjectUrl,
      name: editName?.value || ""
    });

    updateAvatarSelectedStyle();
    avatarPicker?.classList.add("hidden");
  });
}


// Emoji Avatar

avatarOptions.forEach(option => {
  option.addEventListener("click", () => {
    if (!isEditing) {
      return;
    }

    selectedAvatarType = "emoji";
    selectedAvatar = option.dataset.avatar || "";
    selectedAvatarUrl = "";
    selectedAvatarFile = null;

    renderAvatar({
      type: "emoji",
      emoji: selectedAvatar,
      name: editName?.value || ""
    });

    updateAvatarSelectedStyle();
    avatarPicker?.classList.add("hidden");
  });
});


// Interests

document.querySelectorAll(".interest-chip").forEach(chip => {
  chip.addEventListener("click", () => {
    if (!isEditing) {
      return;
    }

    chip.classList.toggle("active");

    chip.setAttribute(
      "aria-pressed",
      chip.classList.contains("active") ? "true" : "false"
    );
  });
});


// Cancel Edit

window.cancelEdit = function () {
  isEditing = false;

  if (editName) {
    editName.value = originalDisplayName;
  }

  restoreOriginalAvatar();

  document.querySelectorAll(".interest-chip").forEach(chip => {
    const selected = originalInterests.includes(chip.dataset.interest);

    chip.classList.toggle("active", selected);
    chip.classList.remove("editable");
    chip.setAttribute("aria-pressed", selected ? "true" : "false");
  });

  if (interestHint) {
    interestHint.textContent = "Click Edit Profile to update your interests.";
  }

  avatarPicker?.classList.add("hidden");
  avatarEditBtn?.classList.add("hidden");

  const identityView = document.getElementById("identity-view");
  const identityEdit = document.getElementById("identity-edit");
  const editActions = document.getElementById("edit-actions");
  const editButton = document.getElementById("edit-toggle-btn");

  if (identityView) {
    identityView.style.display = "block";
  }

  if (identityEdit) {
    identityEdit.style.display = "none";
  }

  editActions?.classList.add("hidden");

  if (editButton) {
    editButton.style.display = "inline-flex";
  }
};


// Save Profile

window.saveProfile = async function () {
  const user = auth.currentUser;

  if (!user) {
    alert("You are not logged in.");
    return;
  }

  const newDisplayName = editName?.value.trim() || "";

  if (!newDisplayName) {
    alert("Display name cannot be empty.");
    return;
  }

  const selectedInterests = Array.from(
    document.querySelectorAll(".interest-chip.active")
  ).map(chip => chip.dataset.interest);

  try {
    let finalAvatarUrl = selectedAvatarUrl;

    // Upload Avatar

    if (selectedAvatarType === "upload" && selectedAvatarFile) {
      const storageRef = ref(
        storage,
        `profilePictures/${user.uid}/avatar`
      );

      await uploadBytes(storageRef, selectedAvatarFile, {
        contentType: selectedAvatarFile.type
      });

      finalAvatarUrl = await getDownloadURL(storageRef);
      selectedAvatarUrl = finalAvatarUrl;
    }

    // Firebase Auth Name

    await updateProfile(user, {
      displayName: newDisplayName
    });

    // Firestore

    const userData = {
      displayName: newDisplayName,
      email: user.email || "",
      avatarType: selectedAvatarType,
      avatar: selectedAvatar,
      avatarUrl: finalAvatarUrl || "",
      interests: selectedInterests,
      updatedAt: serverTimestamp()
    };

    await setDoc(
      doc(db, "users", user.uid),
      userData,
      { merge: true }
    );

    console.log("Profile saved successfully:", userData);

    // Update Original Values

    originalDisplayName = newDisplayName;
    originalAvatarType = selectedAvatarType;
    originalAvatar = selectedAvatar;
    originalAvatarUrl = finalAvatarUrl || "";
    originalInterests = [...selectedInterests];

    selectedAvatarFile = null;

    if (previewObjectUrl) {
      URL.revokeObjectURL(previewObjectUrl);
      previewObjectUrl = null;
    }

    // Render Avatar

    renderAvatar({
      type: originalAvatarType,
      emoji: originalAvatar,
      uploadUrl: originalAvatarUrl,
      googleUrl: user.photoURL || "",
      name: newDisplayName
    });

    if (identityName) {
      identityName.textContent = newDisplayName;
    }

    // Exit Edit

    isEditing = false;

    document.querySelectorAll(".interest-chip").forEach(chip => {
      chip.classList.remove("editable");
    });

    if (interestHint) {
      interestHint.textContent = "Click Edit Profile to update your interests.";
    }

    const identityView = document.getElementById("identity-view");
    const identityEdit = document.getElementById("identity-edit");
    const editActions = document.getElementById("edit-actions");
    const editButton = document.getElementById("edit-toggle-btn");

    if (identityView) {
      identityView.style.display = "block";
    }

    if (identityEdit) {
      identityEdit.style.display = "none";
    }

    editActions?.classList.add("hidden");

    if (editButton) {
      editButton.style.display = "inline-flex";
    }

    avatarEditBtn?.classList.add("hidden");
    avatarPicker?.classList.add("hidden");

    // Toast

    const toast = document.getElementById("save-toast");

    if (toast) {
      toast.classList.add("show");

      setTimeout(() => {
        toast.classList.remove("show");
      }, 2500);
    }
  } catch (error) {
    console.error("Error saving profile:", error);
    alert("Failed to save profile. Check the browser console for details.");
  }
};


// Favourite Attractions

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function loadSavedItineraryCount(user) {
  const countElement = document.getElementById(
    "profile-itinerary-count"
  );

  if (!countElement) {
    return;
  }

  try {
    const itemsById = new Set();
    const queries = [
      query(collection(db, "Itinerary"), where("user_id", "==", user.uid)),
      query(collection(db, "Itinerary"), where("user_uid", "==", user.uid))
    ];

    for (const itineraryQuery of queries) {
      const snapshot = await getDocs(itineraryQuery);
      snapshot.forEach(docSnap => itemsById.add(docSnap.id));
    }

    countElement.textContent = String(itemsById.size);

    console.log(
      "Profile saved itinerary count:",
      itemsById.size
    );

  } catch (error) {
    console.error(
      "Failed to load saved itinerary count:",
      error
    );

    countElement.textContent = "0";
  }
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

    if (loadingEl) {
      loadingEl.style.display = "none";
    }

    if (countEl) {
      countEl.textContent = String(snapshot.size);
    }

    if (snapshot.empty) {
      if (listEl) {
        listEl.style.display = "none";
      }

      if (emptyEl) {
        emptyEl.style.display = "block";
      }

      return;
    }

    if (emptyEl) {
      emptyEl.style.display = "none";
    }

    if (!listEl) {
      return;
    }

    listEl.style.display = "block";
    listEl.innerHTML = "";

    snapshot.forEach(docSnap => {
      const data = docSnap.data();
      const row = document.createElement("div");

      row.className = "fav-row";

      row.innerHTML = `
        <div class="recent-icon">⭐</div>
        <div class="fav-row-name">${escapeHtml(data.name)}</div>
        <button class="fav-remove" type="button">Remove</button>
      `;

      row.querySelector(".fav-remove")?.addEventListener("click", () => {
        removeFavourite(docSnap.id, user);
      });

      listEl.appendChild(row);
    });
  } catch (error) {
    console.error("Failed to load favourites:", error);

    if (loadingEl) {
      loadingEl.style.display = "none";
    }

    if (emptyEl) {
      emptyEl.style.display = "block";
    }
  }
}


// Remove Favourite

async function removeFavourite(documentId, user) {
  try {
    await deleteDoc(
      doc(db, FAVOURITES_COLLECTION, documentId)
    );

    await loadFavourites(user);
  } catch (error) {
    console.error("Failed to remove favourite:", error);
  }
}


// Logout

window.confirmLogout = async function () {
  const confirmed = confirm("Are you sure you want to sign out?");

  if (!confirmed) {
    return;
  }

  try {
    await signOut(auth);
    window.location.href = "/";
  } catch (error) {
    console.error("Logout failed:", error);
  }
};
