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
    const itineraryQuery = query(
      collection(db, "Itinerary"),
      where("user_id", "==", user.uid)
    );

    const snapshot = await getDocs(itineraryQuery);

    countElement.textContent = String(snapshot.size);

    console.log(
      "Dashboard saved itinerary count:",
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

async function loadSavedItineraryCount(user) {
  const countElement = document.getElementById(
    "dashboard-itinerary-count"
  );

  try {
    const itineraryQuery = query(
      collection(db, "Itinerary"),
      where("user_id", "==", user.uid)
    );

    const snapshot = await getDocs(itineraryQuery);

    countElement.textContent = String(snapshot.size);
  } catch (error) {
    console.error("Failed to load itinerary count:", error);
    countElement.textContent = "0";
  }
}

async function loadFavouriteCount(user) {
  const countElement = document.getElementById(
    "dashboard-favourite-count"
  );

  try {
    const favouritesQuery = query(
      collection(db, "Favourites"),
      where("user_id", "==", user.uid)
    );

    const snapshot = await getDocs(favouritesQuery);

    countElement.textContent = String(snapshot.size);
  } catch (error) {
    console.error("Failed to load favourite count:", error);
    countElement.textContent = "0";
  }
}

async function loadSharedItineraryCount(user) {
  const dashboardElement = document.getElementById(
    "dashboard-shared-count"
  );

  const profileElement = document.getElementById(
    "profile-shared-count"
  );

  try {
    const sharedQuery = query(
      collection(db, "Itinerary"),
      where("user_id", "==", user.uid),
      where("status", "==", "Published")
    );

    const snapshot = await getDocs(sharedQuery);
    const count = String(snapshot.size);

    if (dashboardElement) {
      dashboardElement.textContent = count;
    }

    if (profileElement) {
      profileElement.textContent = count;
    }
  } catch (error) {
    console.error("Failed to load shared count:", error);

    if (dashboardElement) dashboardElement.textContent = "0";
    if (profileElement) profileElement.textContent = "0";
  }
}

async function loadUpcomingTrip(user) {
  const element = document.getElementById(
    "dashboard-upcoming-date"
  );

  try {
    const itineraryQuery = query(
      collection(db, "Itinerary"),
      where("user_id", "==", user.uid)
    );

    const snapshot = await getDocs(itineraryQuery);
    const today = new Date().toISOString().slice(0, 10);

    const upcoming = snapshot.docs
      .map(docSnap => ({
        id: docSnap.id,
        ...docSnap.data()
      }))
      .filter(item => item.travel_date && item.travel_date >= today)
      .sort((a, b) =>
        a.travel_date.localeCompare(b.travel_date)
      );

    element.textContent = upcoming.length
      ? upcoming[0].travel_date
      : "No Trip";
  } catch (error) {
    console.error("Failed to load upcoming trip:", error);
    element.textContent = "No Trip";
  }
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function loadRecentItineraries(user) {
  const listElement = document.getElementById(
    "dashboard-recent-list"
  );

  try {
    const itineraryQuery = query(
      collection(db, "Itinerary"),
      where("user_id", "==", user.uid)
    );

    const snapshot = await getDocs(itineraryQuery);

    const itineraries = snapshot.docs
      .map(docSnap => ({
        id: docSnap.id,
        ...docSnap.data()
      }))
      .sort((a, b) => {
        const aTime = a.updated_at?.toMillis?.() || 0;
        const bTime = b.updated_at?.toMillis?.() || 0;
        return bTime - aTime;
      })
      .slice(0, 3);

    if (!itineraries.length) {
      listElement.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🗓️</div>
          <div class="empty-sub">
            No saved itineraries yet.
          </div>
        </div>
      `;
      return;
    }

    listElement.innerHTML = itineraries.map(item => `
      <div class="recent-item">
        <div class="recent-icon">🗓️</div>

        <div class="recent-info">
          <div class="recent-title">
            ${escapeHtml(item.title || "Untitled Trip")}
          </div>

          <div class="recent-meta">
            ${escapeHtml(item.destination || "Malaysia")}
            ·
            ${escapeHtml(item.travel_date || "No date")}
          </div>
        </div>

        <a
          href="/saved-itineraries/${encodeURIComponent(item.id)}"
          class="btn btn-secondary btn-sm">
          View
        </a>
      </div>
    `).join("");
  } catch (error) {
    console.error("Failed to load recent itineraries:", error);

    listElement.innerHTML = `
      <div class="empty-state">
        Unable to load itineraries.
      </div>
    `;
  }
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    window.location.href = "/";
    return;
  }

  await loadDashboardUser(user);

  await Promise.all([
    loadSavedItineraryCount(user),
    loadFavouriteCount(user),
    loadSharedItineraryCount(user),
    loadUpcomingTrip(user),
    loadRecentItineraries(user)
  ]);
});