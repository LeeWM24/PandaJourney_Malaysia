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


// =================================
// HTML Elements
// =================================

const dashboardName =
  document.getElementById("dashboardName");

const heroName =
  document.getElementById("heroName");

const heroUserName =
  document.getElementById("heroUserName");

const heroUserEmail =
  document.getElementById("heroUserEmail");

const avatarImage =
  document.getElementById("avatarImage");

const avatarInitials =
  document.getElementById("avatarInitials");

const savedCountElement =
  document.getElementById("dashboard-saved-count");

const favouriteCountElement =
  document.getElementById("dashboard-favourite-count");

const sharedCountElement =
  document.getElementById("dashboard-shared-count");

const upcomingDateElement =
  document.getElementById("dashboard-upcoming-date");

const recentListElement =
  document.getElementById("dashboard-recent-list");

const dashboardErrorElement =
  document.getElementById("dashboard-error");


// =================================
// Utility Functions
// =================================

function showDashboardLoadError(error) {
  if (!dashboardErrorElement) {
    return;
  }

  dashboardErrorElement.innerHTML = `
    <span aria-hidden="true">⚠️</span>
    <span>
      ${window.PandaFeedback?.friendlyError(error, "Unable to load this information. Please try again.") || "Unable to load this information. Please try again."}
    </span>
    <button type="button" class="dashboard-retry" id="dashboard-retry">Retry</button>
  `;

  dashboardErrorElement.hidden = false;
  document
    .getElementById("dashboard-retry")
    ?.addEventListener("click", loadDashboard);
}


function hideDashboardLoadError() {
  if (!dashboardErrorElement) {
    return;
  }

  dashboardErrorElement.hidden = true;
}


function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}


function getDateString(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value.slice(0, 10);
  }

  const date =
    value?.toDate
      ? value.toDate()
      : value instanceof Date
        ? value
        : null;

  if (date) {
    return [
      date.getFullYear(),

      String(
        date.getMonth() + 1
      ).padStart(2, "0"),

      String(
        date.getDate()
      ).padStart(2, "0")
    ].join("-");
  }

  return "";
}


function getUpdatedTime(value) {
  if (!value) {
    return 0;
  }

  if (value?.toMillis) {
    return value.toMillis();
  }

  if (value?.toDate) {
    return value.toDate().getTime();
  }

  const parsedTime =
    new Date(value).getTime();

  return Number.isNaN(parsedTime)
    ? 0
    : parsedTime;
}


// =================================
// Dashboard User Profile
// =================================

async function loadDashboardUser(user) {
  let name =
    user.displayName ||
    user.email?.split("@")[0] ||
    "Traveller";

  let avatarType = "";
  let avatar = "";
  let avatarUrl = "";
  let authProvider = "";

  try {
    const userRef =
      doc(db, "users", user.uid);

    const snapshot =
      await getDoc(userRef);

    if (snapshot.exists()) {
      const data = snapshot.data();

      console.log(
        "Dashboard profile:",
        data
      );

      if (data.displayName) {
        name = data.displayName;
      }

      avatarType =
        data.avatarType || "";

      avatar =
        data.avatar || "";

      avatarUrl =
        data.avatarUrl || "";

      authProvider =
        data.authProvider || "";

      if (!avatarType && avatar) {
        avatarType = "emoji";
      }

      if (
        authProvider === "google" &&
        !avatarType &&
        user.photoURL
      ) {
        avatarType = "google";
      }
    }
  } catch (error) {
    console.error(
      "Failed to load dashboard profile:",
      error
    );

    showDashboardLoadError(error);
  }

  if (dashboardName) {
    dashboardName.textContent = name;
  }

  if (heroName) {
    heroName.textContent = name;
  }

  if (heroUserName) {
    heroUserName.textContent = name;
  }

  if (heroUserEmail) {
    heroUserEmail.textContent =
      user.email || "";
  }

  renderDashboardAvatar({
    type: avatarType,
    emoji: avatar,
    uploadUrl: avatarUrl,
    googleUrl:
      authProvider === "google"
        ? user.photoURL || ""
        : "",
    name: user.email || name
  });
}


// =================================
// Dashboard Avatar
// =================================

function renderDashboardAvatar({
  type = "",
  emoji = "",
  uploadUrl = "",
  googleUrl = "",
  name = ""
}) {
  if (!avatarImage || !avatarInitials) {
    return;
  }

  if (
    type === "upload" &&
    uploadUrl
  ) {
    avatarImage.src = uploadUrl;
    avatarImage.style.display = "block";

    avatarInitials.style.display =
      "none";

    return;
  }

  if (
    type === "emoji" &&
    emoji
  ) {
    avatarImage.removeAttribute("src");
    avatarImage.style.display = "none";

    avatarInitials.textContent =
      emoji;

    avatarInitials.style.display =
      "flex";

    return;
  }

  if (
    (type === "google" || !type) &&
    googleUrl
  ) {
    avatarImage.src = googleUrl;
    avatarImage.style.display = "block";

    avatarInitials.style.display =
      "none";

    return;
  }

  avatarImage.removeAttribute("src");
  avatarImage.style.display = "none";

  avatarInitials.textContent =
    name.charAt(0).toUpperCase() ||
    "?";

  avatarInitials.style.display =
    "flex";
}


// =================================
// Favourite Count
// =================================

async function loadFavouriteCount(user) {
  if (!favouriteCountElement) {
    console.error(
      "dashboard-favourite-count was not found."
    );
    return;
  }

  try {
    const favouritesQuery = query(
      collection(db, "Favourites"),
      where(
        "user_id",
        "==",
        user.uid
      )
    );

    const snapshot =
      await getDocs(favouritesQuery);

    favouriteCountElement.textContent =
      String(snapshot.size);

    console.log(
      "Dashboard favourite count:",
      snapshot.size
    );
  } catch (error) {
    console.error(
      "Failed to load favourite count:",
      error
    );

    favouriteCountElement.textContent =
      "—";

    showDashboardLoadError(error);
  }
}


// =================================
// Itinerary Dashboard Data
// =================================

async function loadItineraryData(user) {
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

    const itineraries =
      snapshot.docs.map(docSnap => ({
        id: docSnap.id,
        ...docSnap.data()
      }));

    updateSavedCount(itineraries);
    updateSharedCount(itineraries);
    updateUpcomingTrip(itineraries);
    updateSavedItineraries(itineraries);

    console.log(
      "Dashboard itineraries:",
      itineraries.length
    );
  } catch (error) {
    console.error(
      "Failed to load itinerary data:",
      error
    );

    showDashboardLoadError(error);

    if (savedCountElement) {
      savedCountElement.textContent =
        "—";
    }

    if (sharedCountElement) {
      sharedCountElement.textContent =
        "—";
    }

    if (upcomingDateElement) {
      upcomingDateElement.textContent =
        "—";
    }

    if (recentListElement) {
      recentListElement.innerHTML = `
        <div
          class="empty-state"
          style="padding: 28px 0;">

          <div class="empty-icon">
            ⚠️
          </div>

          <div class="empty-sub">
            Unable to load this information. Please try again.
          </div>
        </div>
      `;
    }
  }
}


// =================================
// Saved Itinerary Count
// =================================

function updateSavedCount(itineraries) {
  if (!savedCountElement) {
    return;
  }

  savedCountElement.textContent =
    String(itineraries.length);
}


// =================================
// Published Trip Count
// =================================

function updateSharedCount(itineraries) {
  if (!sharedCountElement) {
    return;
  }

  const sharedCount =
    itineraries.filter(item =>
      String(item.status || "")
        .toLowerCase() ===
      "published"
    ).length;

  sharedCountElement.textContent =
    String(sharedCount);
}


// =================================
// Upcoming Trip
// =================================

function updateUpcomingTrip(itineraries) {
  if (!upcomingDateElement) {
    return;
  }

  const now =
    new Date();

  const today = [
    now.getFullYear(),

    String(
      now.getMonth() + 1
    ).padStart(2, "0"),

    String(
      now.getDate()
    ).padStart(2, "0")
  ].join("-");

  const upcoming =
    itineraries
      .map(item => ({
        ...item,

        dateValue: getDateString(
          item.travel_date ||
          item.date ||
          item.start_date
        )
      }))
      .filter(item =>
        item.dateValue &&
        item.dateValue >= today
      )
      .sort((a, b) =>
        a.dateValue.localeCompare(
          b.dateValue
        )
      );

  upcomingDateElement.textContent =
    upcoming.length
      ? upcoming[0].dateValue
      : "No Trip";
}


// =================================
// Saved Itineraries
// =================================

function updateSavedItineraries(itineraries) {
  if (!recentListElement) {
    return;
  }

  const recentItineraries =
    [...itineraries]
      .sort((a, b) => {
        const aTime =
          getUpdatedTime(
            a.updated_at ||
            a.updatedAt ||
            a.created_at ||
            a.createdAt
          );

        const bTime =
          getUpdatedTime(
            b.updated_at ||
            b.updatedAt ||
            b.created_at ||
            b.createdAt
          );

        return bTime - aTime;
      })
      .slice(0, 3);

  if (!recentItineraries.length) {
    recentListElement.innerHTML = `
      <div
        class="empty-state"
        style="padding: 28px 0;">

        <div class="empty-icon">
          🗓️
        </div>

        <div class="empty-sub">
          No saved itineraries yet. Start by planning your first day trip.
        </div>

        <a
          href="/smart-itinerary"
          class="btn btn-primary btn-sm"
          style="margin-top: 14px;">
          Plan your first trip
        </a>
      </div>
    `;

    return;
  }

  recentListElement.innerHTML =
    recentItineraries
      .map(item => {
        const title =
          item.title ||
          item.trip_name ||
          item.name ||
          "Untitled Trip";

        const destination =
          item.destination ||
          item.location ||
          "Malaysia";

        const travelDate =
          getDateString(
            item.travel_date ||
            item.date ||
            item.start_date
          ) ||
          "No date";

        return `
          <div class="dashboard-recent-item">

            <div class="recent-icon">
              🗓️
            </div>

            <div class="dashboard-recent-info">

              <div class="dashboard-recent-title">
                ${escapeHtml(title)}
              </div>

              <div class="dashboard-recent-meta">
                ${escapeHtml(destination)}
                ·
                ${escapeHtml(travelDate)}
              </div>

            </div>

            <a
              href="/saved-itineraries/${encodeURIComponent(item.id)}/edit"
              class="btn btn-secondary btn-sm dashboard-recent-edit">
              Edit
            </a>

          </div>
        `;
      })
      .join("");
}


// =================================
// Firebase Authentication
// =================================

onAuthStateChanged(
  auth,
  async user => {
    if (!user) {
      console.log(
        "No Firebase user logged in."
      );

      return;
    }

    console.log(
      "Dashboard user:",
      user.uid
    );

    hideDashboardLoadError();

    await Promise.all([
      loadDashboardUser(user),
      loadFavouriteCount(user),
      loadItineraryData(user)
    ]);
  }
);
