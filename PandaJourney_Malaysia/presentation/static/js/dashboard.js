import {
  auth,
  db
} from "./firebase-config.js";

import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

import {
  doc,
  getDoc,
  collection,
  query,
  where,
  getDocs
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

// Itinerary Count

async function loadSavedItineraryCount(user) {
  const countElement = document.getElementById(
    "dashboard-itinerary-count"
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
      "Dashboard saved itinerary count:",
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

// Favourite Count

async function loadFavouriteCount(user) {
  const countElement = document.getElementById("dashboard-favourite-count");

  console.log("Favourite count element:", countElement);
  console.log("Current UID:", user.uid);

  if (!countElement) {
    console.error("dashboard-favourite-count not found.");
    return;
  }

  try {
    const favouritesQuery = query(
      collection(db, "Favourites"),
      where("user_id", "==", user.uid)
    );

    const snapshot = await getDocs(favouritesQuery);

    console.log("Favourite documents found:", snapshot.size);

    snapshot.forEach(docSnap => {
      console.log("Favourite:", docSnap.id, docSnap.data());
    });

    countElement.textContent = String(snapshot.size);
  } catch (error) {
    console.error("Failed to load favourite count:", error);
    countElement.textContent = "0";
  }
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    console.log("No Firebase user logged in.");
    return;
  }

  console.log("Dashboard user:", user);

  let name =
    user.displayName ||
    user.email?.split("@")[0] ||
    "";

  let avatarType = "";
  let avatar = "";
  let avatarUrl = "";

  try {
    const userRef = doc(db, "users", user.uid);
    const snapshot = await getDoc(userRef);

    if (snapshot.exists()) {
      const data = snapshot.data();

      console.log("Dashboard profile:", data);

      if (data.displayName) {
        name = data.displayName;
      }

      avatarType = data.avatarType || "";
      avatar = data.avatar || "";
      avatarUrl = data.avatarUrl || "";

      if (!avatarType && avatar) {
        avatarType = "emoji";
      }
    }
  } catch (error) {
    console.error("Failed to load dashboard profile:", error);
  }

  const dashboardName = document.getElementById("dashboardName");
  const heroName = document.getElementById("heroName");
  const heroUserName = document.getElementById("heroUserName");

  if (dashboardName) {
    dashboardName.textContent = name;
  }

  if (heroName) {
    heroName.textContent = name;
  }

  if (heroUserName) {
    heroUserName.textContent = name;
  }

  const heroUserEmail = document.getElementById("heroUserEmail");

  if (heroUserEmail) {
    heroUserEmail.textContent = user.email || "";
  }

  const avatarImage = document.getElementById("avatarImage");
  const avatarInitials = document.getElementById("avatarInitials");

  if (avatarType === "upload" && avatarUrl) {
    if (avatarImage) {
      avatarImage.src = avatarUrl;
      avatarImage.style.display = "block";
    }

    if (avatarInitials) {
      avatarInitials.style.display = "none";
    }
  } else if (avatarType === "emoji" && avatar) {
    if (avatarImage) {
      avatarImage.style.display = "none";
    }

    if (avatarInitials) {
      avatarInitials.textContent = avatar;
      avatarInitials.style.display = "flex";
    }
  } else if ((avatarType === "google" || !avatarType) && user.photoURL) {
    if (avatarImage) {
      avatarImage.src = user.photoURL;
      avatarImage.style.display = "block";
    }

    if (avatarInitials) {
      avatarInitials.style.display = "none";
    }
  } else {
    if (avatarImage) {
      avatarImage.style.display = "none";
    }

    if (avatarInitials) {
      avatarInitials.textContent = name.charAt(0).toUpperCase();
      avatarInitials.style.display = "flex";
    }
  }

  await loadFavouriteCount(user);
  await loadSavedItineraryCount(user);
});
