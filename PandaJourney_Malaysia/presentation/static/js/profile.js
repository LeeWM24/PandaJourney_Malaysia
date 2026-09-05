import {
  auth,
  db
} from "./firebase-config.js";

import {
  onAuthStateChanged,
  updateProfile,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword
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

// Elements

const identityName =
  document.querySelector(".identity-name");

const identityEmail =
  document.querySelector(".identity-email");

const editName =
  document.getElementById("edit-name");

const editEmail =
  document.getElementById("edit-email");

const avatarImage =
  document.getElementById("avatar-image");

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

const useGoogleAvatarBtn =
  document.getElementById("use-google-avatar");

const uploadAvatarBtn =
  document.getElementById("upload-avatar-btn");

const avatarFileInput =
  document.getElementById("avatar-file-input");

const interestHint =
  document.getElementById("interest-hint");

  const removeFavouriteDialog =
  document.getElementById(
    "remove-favourite-dialog"
  );

const removeFavouriteName =
  document.getElementById(
    "remove-favourite-name"
  );

const cancelRemoveFavouriteBtn =
  document.getElementById(
    "cancel-remove-favourite-btn"
  );

const confirmRemoveFavouriteBtn =
  document.getElementById(
    "confirm-remove-favourite-btn"
  );


// Account Security Elements

const openChangePasswordBtn =
  document.getElementById("open-change-password-btn");

const cancelChangePasswordBtn =
  document.getElementById("cancel-change-password-btn");

const changePasswordForm =
  document.getElementById("change-password-form");

const currentPasswordInput =
  document.getElementById("current-password");

const newPasswordInput =
  document.getElementById("new-password");

const confirmNewPasswordInput =
  document.getElementById("confirm-new-password");

const passwordMessage =
  document.getElementById("password-message");

const savePasswordBtn =
  document.getElementById("save-password-btn");

const googlePasswordNote =
  document.getElementById("google-password-note");


const FAVOURITES_COLLECTION = "Favourites";


// State

let isEditing = false;

let selectedAvatarType = "";
let selectedAvatar = "";
let selectedAvatarUrl = "";
let selectedGoogleAvatarChosen = false;
let isAvatarProcessing = false;

let originalDisplayName = "";
let originalAvatarType = "";
let originalAvatar = "";
let originalAvatarUrl = "";
let originalGoogleAvatarChosen = false;
let originalInterests = [];
let pendingFavouriteRemoval = null;


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
  avatarLetter.textContent =
    firstInitial(name);
}

function isGoogleUser(user, profile = {}) {
  if (profile.authProvider === "password") {
    return false;
  }

  return user?.providerData?.some(provider => provider.providerId === "google.com");
}

function firstInitial(value) {
  return String(value || "?").trim().charAt(0).toUpperCase() || "?";
}


// Avatar Selected Style

function updateAvatarSelectedStyle() {
  avatarOptions.forEach(option => {
    const isSelected =
      selectedAvatarType === "emoji" &&
      option.dataset.avatar === selectedAvatar;

    option.classList.toggle(
      "selected",
      isSelected
    );
  });
}


// Restore Avatar

function restoreOriginalAvatar() {
  selectedAvatarType =
    originalAvatarType;

  selectedAvatar =
    originalAvatar;

  selectedAvatarUrl =
    originalAvatarUrl;

  selectedGoogleAvatarChosen =
    originalGoogleAvatarChosen;

  renderAvatar({
    type:
      originalAvatarType,

    emoji:
      originalAvatar,

    uploadUrl:
      originalAvatarUrl,

    googleUrl:
      originalGoogleAvatarChosen && isGoogleUser(auth.currentUser)
        ? auth.currentUser?.photoURL || ""
        : "",

    name:
      auth.currentUser?.email || originalDisplayName
  });

  updateAvatarSelectedStyle();
}


// Firebase User

onAuthStateChanged(auth, async user => {
  if (!user) {
    console.log("No user logged in.");
    return;
  }

  console.log("Logged in user:", user.uid);

  configurePasswordSection(user);

  const authName =
    user.displayName ||
    user.email?.split("@")[0] ||
    "";

  originalDisplayName = authName;

  if (identityName) {
    identityName.textContent = authName;
  }

  if (identityEmail) {
    identityEmail.textContent =
      user.email || "";
  }

  if (editName) {
    editName.value = authName;
  }

  if (editEmail) {
    editEmail.value =
      user.email || "";
  }

  try {
    const userRef =
      doc(db, "users", user.uid);

    const snapshot =
      await getDoc(userRef);

    if (snapshot.exists()) {
      const data = snapshot.data();

      console.log(
        "Firestore profile:",
        data
      );

      if (data.displayName) {
        originalDisplayName =
          data.displayName;

        if (identityName) {
          identityName.textContent =
            data.displayName;
        }

        if (editName) {
          editName.value =
            data.displayName;
        }
      }

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

      // Avatar Loading

      let storedType =
        data.avatarType || "";

      if (storedType === "google" && !isGoogleUser(user)) {
        storedType = "";
      }

      if (!storedType && data.avatar) {
        storedType = "emoji";
      }

      const googleProfileUrl = isGoogleUser(user, data)
        ? user.photoURL || data.profilePictureUrl || ""
        : "";

      if (!storedType && googleProfileUrl) {
        storedType = "google";
      }

      originalAvatarType =
        storedType;

      originalAvatar =
        data.avatar || "";

      originalAvatarUrl =
        data.avatarUrl || "";

      originalGoogleAvatarChosen =
        storedType === "google";

      selectedAvatarType =
        originalAvatarType;

      selectedAvatar =
        originalAvatar;

      selectedAvatarUrl =
        originalAvatarUrl;

      selectedGoogleAvatarChosen =
        originalGoogleAvatarChosen;

      renderAvatar({
        type: selectedAvatarType,
        emoji: selectedAvatar,
        uploadUrl: selectedAvatarUrl,
        googleUrl: googleProfileUrl,
        name: data.email || user.email || originalDisplayName
      });

      updateAvatarSelectedStyle();

      // Interests

      originalInterests =
        Array.isArray(data.interests)
          ? [...data.interests]
          : [];

      document
        .querySelectorAll(".interest-chip")
        .forEach(chip => {
          const selected =
            originalInterests.includes(
              chip.dataset.interest
            );

          chip.classList.toggle(
            "active",
            selected
          );

          chip.setAttribute(
            "aria-pressed",
            selected ? "true" : "false"
          );
        });
    }

    await Promise.all([
      loadFavourites(user),
      loadSavedItineraryCount(user),
      loadSharedItineraryCount(user)
    ]);
  } catch (error) {
    console.error(
      "Failed to load profile:",
      error
    );
  }
});


// Edit Profile

window.toggleEdit = function () {
  isEditing = true;

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

  editActions
    ?.classList
    .remove("hidden");

  if (editButton) {
    editButton.style.display =
      "none";
  }

  avatarEditBtn
    ?.classList
    .remove("hidden");

  document
    .querySelectorAll(
      ".interest-chip"
    )
    .forEach(chip => {
      chip.classList.add(
        "editable"
      );
    });

  if (interestHint) {
    interestHint.textContent =
      "Select the interests that describe you.";
  }

  const profileIdentityCard =
    document.getElementById(
      "profile-identity-card"
    );

  profileIdentityCard
    ?.classList
    .add("profile-editing");

  profileIdentityCard
    ?.scrollIntoView({
      behavior: "smooth",
      block: "start"
    });

  setTimeout(
    () => {
      editName?.focus();
      editName?.select();
    },
    450
  );
};


// Open Avatar Picker

if (avatarEditBtn) {
  avatarEditBtn.addEventListener(
    "click",
    () => {
      if (!isEditing) {
        return;
      }

      avatarPicker?.classList.toggle(
        "hidden"
      );
    }
  );
}


// Close Avatar Picker

if (closeAvatarPicker) {
  closeAvatarPicker.addEventListener(
    "click",
    () => {
      avatarPicker?.classList.add(
        "hidden"
      );
    }
  );
}

// Google Avatar

if (useGoogleAvatarBtn) {
  useGoogleAvatarBtn
    .addEventListener(
      "click",
      () => {
        if (!isEditing) {
          return;
        }

        const user =
          auth.currentUser;

        if (!user) {
          alert(
            "You are not logged in."
          );

          return;
        }

        if (!user.photoURL) {
          alert(
            "No Google profile photo is available for this account."
          );

          return;
        }

        selectedAvatarType =
          "google";

        selectedAvatar = "";

        selectedAvatarUrl = "";

        selectedGoogleAvatarChosen = true;

        renderAvatar({
          type: "google",

          googleUrl:
            user.photoURL,

          name:
            editName?.value ||
            originalDisplayName
        });

        updateAvatarSelectedStyle();

        avatarPicker
          ?.classList
          .add("hidden");
      }
    );
}

// Upload Button

if (uploadAvatarBtn) {
  uploadAvatarBtn.addEventListener(
    "click",
    () => {
      if (!isEditing) {
        return;
      }

      avatarFileInput?.click();
    }
  );
}


// Upload Preview

function dataUrlSizeInBytes(dataUrl) {
  const base64 =
    dataUrl.split(",")[1] || "";

  const padding =
    base64.match(/=*$/)?.[0].length || 0;

  return (
    Math.floor(
      base64.length * 3 / 4
    ) - padding
  );
}


function loadImageFile(file) {
  return new Promise(
    (resolve, reject) => {
      const image = new Image();

      const objectUrl =
        URL.createObjectURL(file);

      image.onload = () => {
        URL.revokeObjectURL(
          objectUrl
        );

        resolve(image);
      };

      image.onerror = () => {
        URL.revokeObjectURL(
          objectUrl
        );

        reject(
          new Error(
            "Unable to read the selected image."
          )
        );
      };

      image.src = objectUrl;
    }
  );
}


async function compressAvatar(file) {
  const image =
    await loadImageFile(file);

  const outputSize = 400;
  const maximumBytes =
    100 * 1024;

  const canvas =
    document.createElement(
      "canvas"
    );

  canvas.width = outputSize;
  canvas.height = outputSize;

  const context =
    canvas.getContext("2d");

  if (!context) {
    throw new Error(
      "Image processing is not supported."
    );
  }

  // Crop the centre of the image
  // into a square.

  const cropSize =
    Math.min(
      image.naturalWidth,
      image.naturalHeight
    );

  const sourceX =
    (
      image.naturalWidth -
      cropSize
    ) / 2;

  const sourceY =
    (
      image.naturalHeight -
      cropSize
    ) / 2;

  // White background for
  // transparent PNG images.

  context.fillStyle =
    "#ffffff";

  context.fillRect(
    0,
    0,
    outputSize,
    outputSize
  );

  context.drawImage(
    image,
    sourceX,
    sourceY,
    cropSize,
    cropSize,
    0,
    0,
    outputSize,
    outputSize
  );

  let quality = 0.85;

  let dataUrl =
    canvas.toDataURL(
      "image/jpeg",
      quality
    );

  // Reduce JPEG quality until
  // the image is below 100 KB.

  while (
    dataUrlSizeInBytes(
      dataUrl
    ) > maximumBytes &&
    quality > 0.45
  ) {
    quality -= 0.1;

    dataUrl =
      canvas.toDataURL(
        "image/jpeg",
        quality
      );
  }

  if (
    dataUrlSizeInBytes(
      dataUrl
    ) > maximumBytes
  ) {
    throw new Error(
      "The compressed image is still larger than 100 KB."
    );
  }

  return dataUrl;
}


if (avatarFileInput) {
  avatarFileInput.addEventListener(
    "change",
    async () => {
      const file =
        avatarFileInput
          .files?.[0];

      if (!file) {
        return;
      }

      const allowedTypes = [
        "image/jpeg",
        "image/png",
        "image/webp"
      ];

      if (
        !allowedTypes.includes(
          file.type
        )
      ) {
        alert(
          "Please choose a JPG, PNG, or WebP image."
        );

        avatarFileInput.value =
          "";

        return;
      }

      if (
        file.size >
        10 * 1024 * 1024
      ) {
        alert(
          "Profile picture must be smaller than 10 MB."
        );

        avatarFileInput.value =
          "";

        return;
      }

      isAvatarProcessing = true;

      try {
        const compressedDataUrl =
          await compressAvatar(
            file
          );

        selectedAvatarType =
          "upload";

        selectedAvatar = "";

        selectedAvatarUrl =
          compressedDataUrl;

        selectedGoogleAvatarChosen = false;

        renderAvatar({
          type: "upload",
          uploadUrl:
            compressedDataUrl,
          name:
            editName?.value || ""
        });

        updateAvatarSelectedStyle();

        avatarPicker
          ?.classList
          .add("hidden");

        const compressedSize =
          Math.ceil(
            dataUrlSizeInBytes(
              compressedDataUrl
            ) / 1024
          );

        console.log(
          "Compressed avatar size:",
          `${compressedSize} KB`
        );
      } catch (error) {
        console.error(
          "Failed to process avatar:",
          error
        );

        avatarFileInput.value =
          "";

        alert(
          error.message ||
          "Unable to process this image."
        );
      } finally {
        isAvatarProcessing =
          false;
      }
    }
  );
}

// Emoji Avatar

avatarOptions.forEach(option => {
  option.addEventListener(
    "click",
    () => {
      if (!isEditing) {
        return;
      }

      selectedAvatarType = "emoji";

      selectedAvatar =
        option.dataset.avatar || "";

      selectedAvatarUrl = "";

      selectedGoogleAvatarChosen = false;

      renderAvatar({
        type: "emoji",
        emoji: selectedAvatar,
        name: editName?.value || ""
      });

      updateAvatarSelectedStyle();

      avatarPicker?.classList.add(
        "hidden"
      );
    }
  );
});


// Interests

document
  .querySelectorAll(".interest-chip")
  .forEach(chip => {
    chip.addEventListener(
      "click",
      () => {
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
      }
    );
  });


// Cancel Edit

window.cancelEdit = function () {
  isEditing = false;

  if (editName) {
    editName.value =
      originalDisplayName;
  }

  restoreOriginalAvatar();

  document
    .querySelectorAll(".interest-chip")
    .forEach(chip => {
      const selected =
        originalInterests.includes(
          chip.dataset.interest
        );

      chip.classList.toggle(
        "active",
        selected
      );

      chip.classList.remove(
        "editable"
      );

      chip.setAttribute(
        "aria-pressed",
        selected ? "true" : "false"
      );
      document
      .getElementById(
        "profile-identity-card"
      )
      ?.classList
      .remove("profile-editing");
    });

  if (interestHint) {
    interestHint.textContent =
      "Click Edit Profile to update your interests.";
  }

  avatarPicker?.classList.add("hidden");
  avatarEditBtn?.classList.add("hidden");

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
    identityView.style.display = "block";
  }

  if (identityEdit) {
    identityEdit.style.display = "none";
  }

  editActions?.classList.add("hidden");

  if (editButton) {
    editButton.style.display =
      "inline-flex";
  }
};


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
    editName?.value.trim() ||
    "";

  if (!newDisplayName) {
    alert(
      "Please enter valid profile information."
    );

    return;
  }

  if (isAvatarProcessing) {
    alert(
      "Please wait for the profile picture to finish processing."
    );

    return;
  }

  const selectedInterests =
    Array.from(
      document.querySelectorAll(
        ".interest-chip.active"
      )
    ).map(
      chip =>
        chip.dataset.interest
    );

  try {
    await updateProfile(
      user,
      {
        displayName:
          newDisplayName
      }
    );

    const userData = {
      displayName:
        newDisplayName,

      email:
        user.email || "",

      avatarType:
        selectedAvatarType,

      avatar:
        selectedAvatar,

      avatarUrl:
        selectedAvatarUrl || "",

      googleAvatarChosen:
        selectedAvatarType === "google" && selectedGoogleAvatarChosen,

      interests:
        selectedInterests,

      updatedAt:
        serverTimestamp()
    };

    await setDoc(
      doc(
        db,
        "users",
        user.uid
      ),
      userData,
      {
        merge: true
      }
    );

    console.log(
      "Profile saved successfully:",
      userData
    );

    originalDisplayName =
      newDisplayName;

    originalAvatarType =
      selectedAvatarType;

    originalAvatar =
      selectedAvatar;

    originalAvatarUrl =
      selectedAvatarUrl || "";

    originalGoogleAvatarChosen =
      selectedAvatarType === "google" && selectedGoogleAvatarChosen;

    originalInterests =
      [...selectedInterests];

    renderAvatar({
      type:
        originalAvatarType,

      emoji:
        originalAvatar,

      uploadUrl:
        originalAvatarUrl,

      googleUrl:
        originalGoogleAvatarChosen && isGoogleUser(user)
          ? user.photoURL || ""
          : "",

      name:
        user.email || newDisplayName
    });

    if (identityName) {
      identityName.textContent =
        newDisplayName;
    }

    isEditing = false;
    document
    .getElementById(
      "profile-identity-card"
    )
    ?.classList
    .remove("profile-editing");

    document
      .querySelectorAll(
        ".interest-chip"
      )
      .forEach(chip => {
        chip.classList.remove(
          "editable"
        );
      });

    if (interestHint) {
      interestHint.textContent =
        "Click Edit Profile to update your interests.";
    }

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

    editActions
      ?.classList
      .add("hidden");

    if (editButton) {
      editButton.style.display =
        "inline-flex";
    }

    avatarEditBtn
      ?.classList
      .add("hidden");

    avatarPicker
      ?.classList
      .add("hidden");

    const toast =
  document.getElementById(
    "save-toast"
  );

  if (toast) {
    toast.textContent =
      "Profile updated successfully.";

    toast.classList.add(
      "show"
    );

    setTimeout(
      () => {
        toast.classList.remove(
          "show"
        );
      },
      2500
    );
  }
  } catch (error) {
  console.error(
    "Error saving profile:",
    error
  );

  alert(
    error.message ||
    "Unable to update the user profile."
  );
  }
};

// Escape HTML

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}


// Saved Itinerary Count

async function loadSavedItineraryCount(
  user
) {
  const countElement =
    document.getElementById(
      "profile-itinerary-count"
    );

  if (!countElement) {
    return;
  }

  try {
    const itineraryQuery = query(
      collection(db, "Itinerary"),
      where(
        "user_id",
        "==",
        user.uid
      )
    );

    const snapshot =
      await getDocs(itineraryQuery);

    countElement.textContent =
      String(snapshot.size);

    console.log(
      "Profile saved itinerary count:",
      snapshot.size
    );
  } catch (error) {
    console.error(
      "Failed to load saved itinerary count:",
      error
    );

    countElement.textContent = "0";
  }
}


// Favourite Attractions
async function loadFavourites(user) {
  const loadingEl =
    document.getElementById(
      "fav-loading"
    );

  const listEl =
    document.getElementById(
      "fav-list"
    );

  const emptyEl =
    document.getElementById(
      "fav-empty"
    );

  const countEl =
    document.getElementById(
      "fav-count-stat"
    );

  try {
    const favouritesQuery = query(
      collection(
        db,
        FAVOURITES_COLLECTION
      ),
      where(
        "user_id",
        "==",
        user.uid
      )
    );

    const snapshot =
      await getDocs(favouritesQuery);

    if (loadingEl) {
      loadingEl.style.display = "none";
    }

    if (countEl) {
      countEl.textContent =
        String(snapshot.size);
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

    const favouriteDocs =
    snapshot.docs;

  favouriteDocs.forEach(
  (docSnap, index) => {
      const data = docSnap.data();

      const row =
        document.createElement("div");

      row.className = "fav-row";
      if (index >= 5) {
      row.classList.add(
        "fav-row-extra"
      );

      row.hidden = true;
    }

      row.innerHTML = `
        <div class="recent-icon">⭐</div>

        <div class="fav-row-name">
          ${escapeHtml(
            data.name || "Unnamed Attraction"
          )}
        </div>

        <button
          class="fav-remove"
          type="button">
          Remove
        </button>
      `;

      row
        .querySelector(".fav-remove")
        ?.addEventListener(
          "click",
          () => {
            openRemoveFavouriteDialog(
              docSnap.id,
              user,
              data.name || "this attraction"
            );
          }
        );

      listEl.appendChild(row);
    });
    if (favouriteDocs.length > 5) {
  const toggleButton =
    document.createElement(
      "button"
    );

  toggleButton.type = "button";

  toggleButton.className =
    "btn btn-ghost btn-sm fav-toggle";

  toggleButton.textContent =
    `Show all (${favouriteDocs.length})`;

  toggleButton.setAttribute(
    "aria-expanded",
    "false"
  );

  toggleButton.addEventListener(
    "click",
    () => {
      const willExpand =
        toggleButton.getAttribute(
          "aria-expanded"
        ) === "false";

      listEl
        .querySelectorAll(
          ".fav-row-extra"
        )
        .forEach(row => {
          row.hidden =
            !willExpand;
        });

      toggleButton.setAttribute(
        "aria-expanded",
        String(willExpand)
      );

      toggleButton.textContent =
        willExpand
          ? "Show less"
          : `Show all (${favouriteDocs.length})`;
    }
  );

  listEl.appendChild(
    toggleButton
  );
}
  } catch (error) {
    console.error(
      "Failed to load favourites:",
      error
    );

    if (loadingEl) {
      loadingEl.style.display = "none";
    }

    if (emptyEl) {
      emptyEl.style.display = "block";
    }

    if (countEl) {
      countEl.textContent = "0";
    }
  }
}


// Remove Favourite

function openRemoveFavouriteDialog(
  documentId,
  user,
  attractionName
) {
  pendingFavouriteRemoval = {
    documentId,
    user
  };

  if (removeFavouriteName) {
    removeFavouriteName.textContent =
      attractionName;
  }

  removeFavouriteDialog
    ?.showModal();
}


function closeRemoveFavouriteDialog() {
  pendingFavouriteRemoval =
    null;

  if (
    removeFavouriteDialog?.open
  ) {
    removeFavouriteDialog.close();
  }
}


cancelRemoveFavouriteBtn
  ?.addEventListener(
    "click",
    closeRemoveFavouriteDialog
  );


removeFavouriteDialog
  ?.addEventListener(
    "click",
    event => {
      if (
        event.target ===
        removeFavouriteDialog
      ) {
        closeRemoveFavouriteDialog();
      }
    }
  );


confirmRemoveFavouriteBtn
  ?.addEventListener(
    "click",
    async () => {
      if (
        !pendingFavouriteRemoval
      ) {
        return;
      }

      const {
        documentId,
        user
      } = pendingFavouriteRemoval;

      try {
        confirmRemoveFavouriteBtn
          .disabled = true;

        confirmRemoveFavouriteBtn
          .textContent =
          "Removing...";

        await deleteDoc(
          doc(
            db,
            FAVOURITES_COLLECTION,
            documentId
          )
        );

        closeRemoveFavouriteDialog();

        await loadFavourites(
          user
        );
      } catch (error) {
        console.error(
          "Failed to remove favourite:",
          error
        );

        alert(
          "Unable to remove this favourite. Please try again."
        );
      } finally {
        confirmRemoveFavouriteBtn
          .disabled = false;

        confirmRemoveFavouriteBtn
          .textContent =
          "Remove";
      }
    }
  );
// Shared Itinerary Count

async function loadSharedItineraryCount(
  user
) {
  const countElement =
    document.getElementById(
      "profile-shared-count"
    );

  if (!countElement) {
    return;
  }

  try {
    const sharedQuery = query(
      collection(db, "Itinerary"),
      where(
        "user_id",
        "==",
        user.uid
      ),
      where(
        "status",
        "==",
        "Published"
      )
    );

    const snapshot =
      await getDocs(sharedQuery);

    countElement.textContent =
      String(snapshot.size);
  } catch (error) {
    console.error(
      "Failed to load shared itinerary count:",
      error
    );

    countElement.textContent = "0";
  }
}


// Account Security

let canChangePassword = false;


function configurePasswordSection(user) {
  if (
    !openChangePasswordBtn ||
    !changePasswordForm ||
    !googlePasswordNote
  ) {
    return;
  }

  canChangePassword =
    user.providerData.some(
      provider =>
        provider.providerId ===
        "password"
    );

  changePasswordForm.reset();
  changePasswordForm.classList.add(
    "hidden"
  );

  if (passwordMessage) {
    passwordMessage.textContent = "";

    passwordMessage.className =
      "password-message";
  }

  if (canChangePassword) {
    openChangePasswordBtn
      .classList
      .remove("hidden");

    googlePasswordNote
      .classList
      .add("hidden");
  } else {
    openChangePasswordBtn
      .classList
      .add("hidden");

    googlePasswordNote
      .classList
      .remove("hidden");
  }
}


openChangePasswordBtn?.addEventListener(
  "click",
  () => {
    if (!canChangePassword) {
      return;
    }

    changePasswordForm
      ?.classList
      .remove("hidden");

    openChangePasswordBtn
      .classList
      .add("hidden");

    currentPasswordInput?.focus();
  }
);


function showPasswordMessage(
  message,
  type
) {
  if (!passwordMessage) {
    return;
  }

  passwordMessage.textContent =
    message;

  passwordMessage.className =
    `password-message ${type} show`;
}


function resetPasswordForm() {
  changePasswordForm?.reset();

  changePasswordForm
    ?.classList
    .add("hidden");

  if (canChangePassword) {
    openChangePasswordBtn
      ?.classList
      .remove("hidden");
  } else {
    openChangePasswordBtn
      ?.classList
      .add("hidden");
  }

  if (passwordMessage) {
    passwordMessage.textContent = "";

    passwordMessage.className =
      "password-message";
  }
}

cancelChangePasswordBtn
  ?.addEventListener(
    "click",
    resetPasswordForm
  );


changePasswordForm
  ?.addEventListener(
    "submit",
    async event => {
      event.preventDefault();

      const user = auth.currentUser;

      if (!user?.email) {
        showPasswordMessage(
          "Unable to verify the current account.",
          "error"
        );
        return;
      }

      const currentPassword =
        currentPasswordInput?.value || "";

      const newPassword =
        newPasswordInput?.value || "";

      const confirmPassword =
        confirmNewPasswordInput?.value || "";

      if (!currentPassword) {
        showPasswordMessage(
          "Please enter your current password.",
          "error"
        );
        return;
      }

      const strongPassword =
      password.length >= 8 &&
      /[A-Z]/.test(password) &&
      /[a-z]/.test(password) &&
      /[^A-Za-z0-9]/.test(password);

      if (!strongPassword) {
        errorBox.textContent =
          "Password must contain at least 8 characters, including uppercase, lowercase, and a special character.";

        errorBox.style.display = "block";
        return;
      }

      if (
        newPassword !==
        confirmPassword
      ) {
        showPasswordMessage(
          "New passwords do not match.",
          "error"
        );
        return;
      }

      if (
        currentPassword ===
        newPassword
      ) {
        showPasswordMessage(
          "New password must be different from the current password.",
          "error"
        );
        return;
      }

      try {
        if (savePasswordBtn) {
          savePasswordBtn.disabled =
            true;

          savePasswordBtn.textContent =
            "Updating...";
        }

        const credential =
          EmailAuthProvider.credential(
            user.email,
            currentPassword
          );

        await reauthenticateWithCredential(
          user,
          credential
        );

        await updatePassword(
          user,
          newPassword
        );

        changePasswordForm.reset();

        showPasswordMessage(
          "Password updated successfully.",
          "success"
        );
      } catch (error) {
        console.error(
          "Failed to update password:",
          error
        );

        let message =
          "Failed to update password. Please try again.";

        if (
          error.code ===
            "auth/invalid-credential" ||
          error.code ===
            "auth/wrong-password"
        ) {
          message =
            "The current password is incorrect.";
        } else if (
          error.code ===
          "auth/weak-password"
        ) {
          message =
            "The new password is too weak.";
        } else if (
          error.code ===
          "auth/too-many-requests"
        ) {
          message =
            "Too many attempts. Please wait and try again.";
        } else if (
          error.code ===
          "auth/network-request-failed"
        ) {
          message =
            "Network error. Please check your connection.";
        }

        showPasswordMessage(
          message,
          "error"
        );
      } finally {
        if (savePasswordBtn) {
          savePasswordBtn.disabled =
            false;

          savePasswordBtn.textContent =
            "Update Password";
        }
      }
    }
  );
