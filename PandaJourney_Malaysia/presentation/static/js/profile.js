import { initializeApp } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-app.js";

import {
    getAuth,
    onAuthStateChanged,
    signOut
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

import {
    getFirestore,
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
const db = getFirestore(app);

const FAVOURITES_COLLECTION = "Favourites";

let currentUser = null;
let editMode = false;

// Check Login

onAuthStateChanged(auth, async (user) => {

    if (!user) {
        window.location.href = "/";
        return;
    }

    currentUser = user;

    console.log("Current user:", user.uid);

    await loadUserProfile(user);
    await loadFavourites(user);
});

// Load User Profile

async function loadUserProfile(user) {

    try {

        const userRef = doc(db, "users", user.uid);
        const userSnap = await getDoc(userRef);

        const data = userSnap.exists()
            ? userSnap.data()
            : {};

        const name =
            data.displayName ||
            user.displayName ||
            "User";

        const email =
            data.email ||
            user.email ||
            "";

        document.querySelector(".identity-name").textContent = name;
        document.querySelector(".identity-email").textContent = email;

        document.getElementById("edit-name").value = name;
        document.getElementById("edit-email").value = email;

        const photoURL =
            data.profilePictureUrl ||
            user.photoURL;

        if (photoURL) {

            const avatar = document.getElementById("avatar");

            avatar.style.backgroundImage =
                `url("${photoURL}")`;

            avatar.style.backgroundSize = "cover";
            avatar.style.backgroundPosition = "center";

            avatar.childNodes[0].textContent = "";

        } else {
            setAvatarInitials(name);
        }

    } catch (error) {

        console.error("Failed to retrieve profile:", error);
    }
}

// Avatar

function setAvatarInitials(name) {

    const initials = name
        .split(" ")
        .map(word => word[0])
        .join("")
        .slice(0, 2)
        .toUpperCase();

    const avatar = document.getElementById("avatar");

    avatar.style.backgroundImage = "none";
    avatar.childNodes[0].textContent = initials;
}


// Edit Profile

function toggleEdit() {

    editMode = !editMode;
    applyEditMode();
}

function applyEditMode() {

    document.getElementById("identity-view").style.display =
        editMode ? "none" : "block";

    document.getElementById("identity-edit").style.display =
        editMode ? "flex" : "none";

    document.getElementById("avatar-edit-btn")
        .classList.toggle("hidden", !editMode);

    document.getElementById("edit-actions")
        .classList.toggle("hidden", !editMode);

    const button =
        document.getElementById("edit-toggle-btn");

    button.textContent =
        editMode ? "Cancel" : "✎ Edit Profile";

    button.className =
        editMode
            ? "btn btn-ghost btn-sm"
            : "btn btn-secondary btn-sm";

    button.onclick =
        editMode ? cancelEdit : toggleEdit;
}

async function cancelEdit() {

    editMode = false;

    if (currentUser) {
        await loadUserProfile(currentUser);
    }

    applyEditMode();
}

// Save Profile

async function saveProfile() {

    if (!currentUser) {
        console.error("No logged-in user.");
        return;
    }

    const name =
        document.getElementById("edit-name").value.trim()
        || currentUser.displayName
        || "User";

    const email =
        document.getElementById("edit-email").value.trim()
        || currentUser.email
        || "";

    try {

        const userRef =
            doc(db, "users", currentUser.uid);

        await setDoc(userRef, {

            uid: currentUser.uid,
            displayName: name,
            email: email,
            profilePictureUrl: currentUser.photoURL || "",
            updatedAt: serverTimestamp()

        }, { merge: true });

        await loadUserProfile(currentUser);

        editMode = false;
        applyEditMode();

        showToast();

    } catch (error) {

        console.error(
            "Failed to update profile:",
            error
        );
    }
}


// Toast

function showToast() {

    const toast =
        document.getElementById("save-toast");

    toast.classList.add("show");

    setTimeout(() => {
        toast.classList.remove("show");
    }, 3000);
}

// Logout

async function confirmLogout() {

    try {

        await signOut(auth);

        window.location.href = "/";

    } catch (error) {

        console.error("Sign out failed:", error);
    }
}

// Logout Modal

function openLogoutModal() {

    document
        .getElementById("logout-modal")
        .classList.add("show");
}

function closeLogoutModal() {

    document
        .getElementById("logout-modal")
        .classList.remove("show");
}


// Close modal when clicking outside
document
    .getElementById("logout-modal")
    .addEventListener("click", function (e) {

        if (e.target === this) {
            closeLogoutModal();
        }
    });

// Make functions available to HTML

window.toggleEdit = toggleEdit;
window.cancelEdit = cancelEdit;
window.saveProfile = saveProfile;

window.confirmLogout = confirmLogout;
window.openLogoutModal = openLogoutModal;
window.closeLogoutModal = closeLogoutModal;