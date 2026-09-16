import {
  auth,
  db
} from "./firebase-config.js";

import {
  onAuthStateChanged,
  updateProfile,
  EmailAuthProvider,
  reauthenticateWithCredential,
  updatePassword,
  linkWithCredential
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

const profilePageMessage =
  document.getElementById("profile-page-message");

function showProfilePageMessage(message, type = "error") {
  window.PandaFeedback?.show(profilePageMessage, message, type);
}

const identityEmail =
  document.querySelector(".identity-email");

const editName =
  document.getElementById("edit-name");

const displayNameCount =
  document.getElementById("display-name-count");

const DISPLAY_NAME_MAX_LENGTH = 100;

function updateDisplayNameCount() {
  if (!displayNameCount) {
    return;
  }

  const characterCount =
    Array.from(editName?.value || "").length;

  displayNameCount.textContent =
    `${characterCount}/${DISPLAY_NAME_MAX_LENGTH}`;
}

editName?.addEventListener(
  "input",
  updateDisplayNameCount
);

window.addEventListener("beforeunload", event => {
  if (!isEditing) {
    return;
  }

  event.preventDefault();
  event.returnValue = "";
});

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

const favouriteDetailsDialog =
  document.getElementById(
    "favourite-details-dialog"
  );

const favouriteDetailsTitle =
  document.getElementById(
    "favourite-details-title"
  );

const favouriteDetailsMeta =
  document.getElementById(
    "favourite-details-meta"
  );

const favouriteDetailsDescription =
  document.getElementById(
    "favourite-details-description"
  );

const closeFavouriteDetailsBtn =
  document.getElementById(
    "close-favourite-details-btn"
  );

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

const currentPasswordGroup =
  document.getElementById("current-password-group");

const passwordSecuritySubtitle =
  document.getElementById("password-security-subtitle");

const passwordMatchHint =
  document.getElementById("password-match-hint");

const passwordRequirementElements =
  document.querySelectorAll("[data-password-rule]");


const FAVOURITES_COLLECTION = "Favourites";
const FAVOURITES_PAGE_SIZE = 5;
let favouriteCurrentPage = 1;
let linkingPasswordProvider = false;


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
    updateDisplayNameCount();
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
          updateDisplayNameCount();
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
  updateDisplayNameCount();

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
          showProfilePageMessage("Your session has expired. Please sign in again.");
          return;
        }

        if (!user.photoURL) {
          showProfilePageMessage("No Google profile photo is available for this account.", "warning");
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
        showProfilePageMessage("Please choose a JPG, PNG, or WebP image.");

        avatarFileInput.value =
          "";

        return;
      }

      if (
        file.size >
        10 * 1024 * 1024
      ) {
        showProfilePageMessage("Profile picture must be smaller than 10 MB.");

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

        showProfilePageMessage(
          error.message || "Unable to process this image."
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
    updateDisplayNameCount();
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
  const messageElement =
    document.getElementById("profile-edit-message");
  const saveButton =
    document.getElementById("save-profile-btn");
  const user =
    auth.currentUser;

  if (!user) {
    window.PandaFeedback?.show(
      messageElement,
      "Your session has expired. Please sign in again."
    );
    return;
  }

  const newDisplayName =
    editName?.value.trim() ||
    "";

  if (!newDisplayName) {
    window.PandaFeedback?.show(
      messageElement,
      "Please enter a display name."
    );
    editName?.focus();
    return;
  }

  if (Array.from(newDisplayName).length > 100) {
    window.PandaFeedback?.show(
      messageElement,
      "Display name must not exceed 100 characters."
    );
    editName?.focus();
    return;
  }

  if (isAvatarProcessing) {
    window.PandaFeedback?.show(
      messageElement,
      "Please wait for the profile picture to finish processing.",
      "warning"
    );
    return;
  }

  if (!navigator.onLine) {
    window.PandaFeedback?.show(
      messageElement,
      "You are offline. Check your internet connection before saving."
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
    window.PandaFeedback?.clear(messageElement);
    if (saveButton) {
      saveButton.disabled = true;
      saveButton.setAttribute("aria-busy", "true");
      saveButton.textContent = "Saving...";
    }
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

  window.PandaFeedback?.show(
    messageElement,
    window.PandaFeedback?.friendlyError(
      error,
      "Unable to update your profile. Your previous information is unchanged."
    ) || "Unable to update your profile. Please try again."
  );
  } finally {
    if (saveButton) {
      saveButton.disabled = false;
      saveButton.removeAttribute("aria-busy");
      saveButton.textContent = "✓ Confirm Changes";
    }
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


// Favourite Attraction Details

function firstAvailable(data, keys) {
  for (const key of keys) {
    const value = data?.[key];

    if (
      value !== undefined &&
      value !== null &&
      String(value).trim()
    ) {
      return String(value).trim();
    }
  }

  return "";
}

function openFavouriteDetails(data) {
  if (!favouriteDetailsDialog) {
    return;
  }

  const name = firstAvailable(
    data,
    ["name", "attraction_name"]
  ) || "Favourite attraction";

  const location = firstAvailable(
    data,
    ["location", "address", "state", "city"]
  );

  const category = firstAvailable(
    data,
    ["category", "type"]
  );

  const rating = firstAvailable(
    data,
    ["rating", "minimum_rating"]
  );

  const description = firstAvailable(
    data,
    ["description", "summary", "details"]
  );

  if (favouriteDetailsTitle) {
    favouriteDetailsTitle.textContent = name;
  }

  if (favouriteDetailsMeta) {
    favouriteDetailsMeta.innerHTML = "";

    [
      location ? `📍 ${location}` : "",
      category ? `🏷️ ${category}` : "",
      rating ? `⭐ ${rating}` : ""
    ]
      .filter(Boolean)
      .forEach(value => {
        const pill =
          document.createElement("span");

        pill.className =
          "favourite-details-pill";

        pill.textContent = value;

        favouriteDetailsMeta.appendChild(
          pill
        );
      });

    favouriteDetailsMeta.hidden =
      !favouriteDetailsMeta.children.length;
  }

  if (favouriteDetailsDescription) {
    favouriteDetailsDescription.textContent =
      description ||
      "This attraction is saved in your favourites. Open the Attractions page to explore its full information.";
  }

  favouriteDetailsDialog.showModal();
}

function closeFavouriteDetails() {
  if (favouriteDetailsDialog?.open) {
    favouriteDetailsDialog.close();
  }
}

closeFavouriteDetailsBtn?.addEventListener(
  "click",
  closeFavouriteDetails
);

favouriteDetailsDialog?.addEventListener(
  "click",
  event => {
    if (event.target === favouriteDetailsDialog) {
      closeFavouriteDetails();
    }
  }
);


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

    console.log(
      "Current user UID:",
      user.uid
    );

    console.log(
      "Favourite count:",
      snapshot.size
    );

    if (loadingEl) {
      loadingEl.style.display = "none";
    }

    if (countEl) {
      countEl.textContent =
        String(snapshot.size);
    }

    // No favourites
    if (snapshot.empty) {
      if (listEl) {
        listEl.style.display = "none";
        listEl.innerHTML = "";
      }

      if (emptyEl) {
        emptyEl.innerHTML = `
          <div class="empty-icon">
            ⭐
          </div>

          <div class="empty-title">
            No favourite attractions yet.
          </div>

          <div class="empty-sub">
            Star an attraction on the Attractions page
            to save it here.
          </div>
        `;

        emptyEl.style.display = "block";
      }

      return;
    }

    // Favourites exist
    if (emptyEl) {
      emptyEl.style.display = "none";
    }

    if (!listEl) {
      return;
    }

    listEl.style.display = "block";
    listEl.innerHTML = "";

    const collator = new Intl.Collator(
      "en",
      { sensitivity: "base", numeric: true }
    );

    const favouriteDocs = [...snapshot.docs].sort((left, right) => {
      const leftData = left.data();
      const rightData = right.data();
      const leftName = leftData.name || leftData.attraction_name || "Unnamed Attraction";
      const rightName = rightData.name || rightData.attraction_name || "Unnamed Attraction";
      return collator.compare(leftName, rightName);
    });

    const totalPages = Math.ceil(
      favouriteDocs.length / FAVOURITES_PAGE_SIZE
    );
    favouriteCurrentPage = Math.min(
      Math.max(favouriteCurrentPage, 1),
      totalPages
    );

    const renderFavouritePage = () => {
      listEl.innerHTML = "";
      const startIndex =
        (favouriteCurrentPage - 1) * FAVOURITES_PAGE_SIZE;
      const pageDocs = favouriteDocs.slice(
        startIndex,
        startIndex + FAVOURITES_PAGE_SIZE
      );

      pageDocs.forEach(
      docSnap => {
        const data =
          docSnap.data();

        const attractionName =
          data.name ||
          data.attraction_name ||
          "Unnamed Attraction";

        const row =
          document.createElement("div");

        row.className = "fav-row";

        row.innerHTML = `
          <div class="recent-icon">
            ⭐
          </div>

          <div class="fav-row-name">
            <button
              class="fav-name-button"
              type="button"
              title="View attraction information">
              ${escapeHtml(attractionName)}
            </button>
          </div>

          <button
            class="fav-remove"
            type="button">
            Remove
          </button>
        `;

        row
          .querySelector(".fav-name-button")
          ?.addEventListener(
            "click",
            () => {
              openFavouriteDetails(data);
            }
          );

        row
          .querySelector(".fav-remove")
          ?.addEventListener(
            "click",
            () => {
              openRemoveFavouriteDialog(
                docSnap.id,
                user,
                attractionName
              );
            }
          );

        listEl.appendChild(row);
      }
    );

      if (totalPages > 1) {
        const pagination = document.createElement("nav");
        pagination.className = "fav-pagination";
        pagination.setAttribute("aria-label", "Favourite attractions pages");

        const addPageButton = (label, page, disabled, current = false) => {
          const button = document.createElement("button");
          button.type = "button";
          button.className = `btn btn-ghost btn-sm fav-page-button${current ? " active" : ""}`;
          button.textContent = label;
          button.disabled = disabled;
          if (current) button.setAttribute("aria-current", "page");
          button.addEventListener("click", () => {
            favouriteCurrentPage = page;
            renderFavouritePage();
          });
          pagination.appendChild(button);
        };

        addPageButton("Previous", favouriteCurrentPage - 1, favouriteCurrentPage === 1);
        for (let page = 1; page <= totalPages; page += 1) {
          addPageButton(String(page), page, page === favouriteCurrentPage, page === favouriteCurrentPage);
        }
        addPageButton("Next", favouriteCurrentPage + 1, favouriteCurrentPage === totalPages);
        listEl.appendChild(pagination);
      }
    };

    renderFavouritePage();

  } catch (error) {
    console.error(
      "Failed to load favourites:",
      error
    );

    if (loadingEl) {
      loadingEl.style.display = "none";
    }

    if (listEl) {
      listEl.style.display = "none";
      listEl.innerHTML = "";
    }

    if (emptyEl) {
      emptyEl.innerHTML = `
        <div class="empty-icon">
          ⚠️
        </div>

        <div class="empty-title">
          Unable to load favourite attractions.
        </div>

        <div class="empty-sub">
          Please try again.
        </div>
      `;

      emptyEl.style.display = "block";
    }

    if (countEl) {
      countEl.textContent = "—";
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

        showProfilePageMessage(
          window.PandaFeedback?.friendlyError(
            error,
            "Unable to remove this favourite. Please try again."
          ) || "Unable to remove this favourite. Please try again."
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


function getPasswordRules(password) {
  return {
    length: password.length >= 8,
    uppercase: /[A-Z]/.test(password),
    lowercase: /[a-z]/.test(password),
    special: /[^A-Za-z0-9]/.test(password)
  };
}


function updatePasswordGuidance() {
  const password = newPasswordInput?.value || "";
  const confirmation = confirmNewPasswordInput?.value || "";
  const rules = getPasswordRules(password);

  passwordRequirementElements.forEach(element => {
    element.classList.toggle(
      "met",
      Boolean(rules[element.dataset.passwordRule])
    );
  });

  if (!passwordMatchHint) {
    return;
  }

  if (!confirmation) {
    passwordMatchHint.textContent = "";
    passwordMatchHint.className = "password-match-hint";
  } else if (password === confirmation) {
    passwordMatchHint.textContent = "✓ Passwords match";
    passwordMatchHint.className = "password-match-hint match";
  } else {
    passwordMatchHint.textContent = "Passwords do not match";
    passwordMatchHint.className = "password-match-hint mismatch";
  }
}


newPasswordInput?.addEventListener("input", updatePasswordGuidance);
confirmNewPasswordInput?.addEventListener("input", updatePasswordGuidance);

document
  .querySelectorAll("[data-password-target]")
  .forEach(button => {
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.passwordTarget);
      if (!input) return;

      const willShow = input.type === "password";
      input.type = willShow ? "text" : "password";
      button.textContent = willShow ? "Hide" : "Show";
      button.setAttribute(
        "aria-label",
        `${willShow ? "Hide" : "Show"} ${input.id.replaceAll("-", " ")}`
      );
    });
  });


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

  const hasGoogleProvider =
    user.providerData.some(
      provider =>
        provider.providerId ===
        "google.com"
    );

  linkingPasswordProvider =
    !canChangePassword && hasGoogleProvider;

  changePasswordForm.classList.toggle(
    "link-password-mode",
    linkingPasswordProvider
  );

  changePasswordForm.reset();
  updatePasswordGuidance();
  changePasswordForm.classList.add(
    "hidden"
  );

  if (passwordMessage) {
    passwordMessage.textContent = "";
    passwordMessage.className =
      "password-message";
  }

  openChangePasswordBtn
    .classList
    .toggle(
      "hidden",
      !canChangePassword && !hasGoogleProvider
    );

  if (linkingPasswordProvider) {
    openChangePasswordBtn.textContent =
      "🔗 Add Password Sign-In";

    currentPasswordGroup
      ?.classList
      .add("hidden");

    currentPasswordInput?.removeAttribute(
      "required"
    );

    googlePasswordNote.textContent =
      "Your account currently uses Google. Add a password to sign in with the same email and keep the same profile, favourites and itineraries.";

    googlePasswordNote
      .classList
      .remove("hidden");

    if (passwordSecuritySubtitle) {
      passwordSecuritySubtitle.textContent =
        "Add another secure sign-in method to this account.";
    }

    if (savePasswordBtn) {
      savePasswordBtn.textContent =
        "Add Password Sign-In";
    }
  } else {
    openChangePasswordBtn.textContent =
      "🔒 Change Password";

    currentPasswordGroup
      ?.classList
      .remove("hidden");

    currentPasswordInput?.setAttribute(
      "required",
      ""
    );

    googlePasswordNote
      .classList
      .add("hidden");

    if (passwordSecuritySubtitle) {
      passwordSecuritySubtitle.textContent =
        "Update the password used to sign in to your account.";
    }

    if (savePasswordBtn) {
      savePasswordBtn.textContent =
        "Update Password";
    }
  }
}


openChangePasswordBtn?.addEventListener(
  "click",
  () => {
    if (!canChangePassword && !linkingPasswordProvider) {
      return;
    }

    changePasswordForm
      ?.classList
      .remove("hidden");

    openChangePasswordBtn
      .classList
      .add("hidden");

    if (linkingPasswordProvider) {
      newPasswordInput?.focus();
    } else {
      currentPasswordInput?.focus();
    }
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
  updatePasswordGuidance();

  document
    .querySelectorAll("[data-password-target]")
    .forEach(button => {
      const input = document.getElementById(button.dataset.passwordTarget);
      if (input) input.type = "password";
      button.textContent = "Show";
    });

  changePasswordForm
    ?.classList
    .add("hidden");

  if (canChangePassword || linkingPasswordProvider) {
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

      if (!linkingPasswordProvider && !currentPassword) {
        showPasswordMessage(
          "Please enter your current password.",
          "error"
        );
        return;
      }

      const passwordRules = getPasswordRules(newPassword);
      const strongPassword = Object.values(passwordRules).every(Boolean);

    if (!strongPassword) {
      showPasswordMessage(
        "Password must contain at least 8 characters, including uppercase, lowercase, and a special character.",
        "error"
      );

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
        !linkingPasswordProvider &&
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
            linkingPasswordProvider
              ? "Adding..."
              : "Updating...";
        }

        if (linkingPasswordProvider) {
          const credential =
            EmailAuthProvider.credential(
              user.email,
              newPassword
            );

          await linkWithCredential(
            user,
            credential
          );

          canChangePassword = true;
          linkingPasswordProvider = false;
          changePasswordForm.classList.remove(
            "link-password-mode"
          );

          currentPasswordGroup
            ?.classList
            .remove("hidden");

          currentPasswordInput?.setAttribute(
            "required",
            ""
          );

          googlePasswordNote
            ?.classList
            .add("hidden");

          openChangePasswordBtn.textContent =
            "🔒 Change Password";

          if (passwordSecuritySubtitle) {
            passwordSecuritySubtitle.textContent =
              "Update the password used to sign in to your account.";
          }

          showPasswordMessage(
            "Password sign-in added successfully. You can now use Google or your email and password with the same account.",
            "success"
          );
        } else {
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

          showPasswordMessage(
            "Password updated successfully.",
            "success"
          );
        }

        changePasswordForm.reset();
        updatePasswordGuidance();
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
        } else if (
          error.code ===
          "auth/provider-already-linked"
        ) {
          message =
            "Password sign-in is already connected to this account.";
        } else if (
          error.code ===
            "auth/credential-already-in-use" ||
          error.code ===
            "auth/email-already-in-use"
        ) {
          message =
            "This email/password sign-in belongs to another Firebase account and cannot be linked automatically.";
        } else if (
          error.code ===
          "auth/requires-recent-login"
        ) {
          message =
            "For security, sign out and sign in with Google again before adding a password.";
        } else if (
          error.code ===
          "auth/operation-not-allowed"
        ) {
          message =
            "Email/password sign-in is not enabled for this Firebase project.";
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
            linkingPasswordProvider
              ? "Add Password Sign-In"
              : "Update Password";
        }
      }
    }
  );
