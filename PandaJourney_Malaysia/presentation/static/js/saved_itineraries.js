import {
  auth,
  db
} from "./firebase-config.js";

import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

import {
  collection,
  query,
  where,
  getDocs,
  deleteDoc,
  doc,
  updateDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

const ITINERARY_COLLECTION = "Itinerary";
const ITINERARY_STOP_COLLECTION = "itinerary_stops";

const loadingElement = document.getElementById("saved-loading");

const upcomingSection = document.getElementById("upcoming-section");
const listElement = document.getElementById("saved-list");
const emptyElement = document.getElementById("saved-empty");

const pastControl = document.getElementById("past-control");
const pastSection = document.getElementById("past-section");
const pastListElement = document.getElementById("past-list");
const togglePastButton = document.getElementById("toggle-past-btn");

let pastVisible = false;

// ================================
// Helper
// ================================

function hideLoading() {
  if (loadingElement) {
    loadingElement.style.display = "none";
  }
}

function showEmpty() {
  if (upcomingSection) {
    upcomingSection.style.display = "none";
  }

  if (emptyElement) {
    emptyElement.style.display = "block";
  }
}

function showUpcomingList() {
  if (emptyElement) {
    emptyElement.style.display = "none";
  }

  if (upcomingSection) {
    upcomingSection.style.display = "block";
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

function getBadgeClass(status) {
  if (status === "Published") return "badge-success";
  if (status === "Draft") return "badge-warning";
  if (status === "Upcoming") return "badge-info";
  return "badge-muted";
}

function getTodayDateKey() {
  const today = new Date();

  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, "0");
  const day = String(today.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function isPastPlan(dateText) {
  if (!dateText) return false;

  const todayKey = getTodayDateKey();

  return String(dateText) < todayKey;
}

function formatDate(dateText) {
  if (!dateText) return "No date";

  const date = new Date(dateText);

  if (Number.isNaN(date.getTime())) {
    return dateText;
  }

  return date.toLocaleDateString("en-MY", {
    year: "numeric",
    month: "short",
    day: "2-digit"
  });
}

function formatDuration(hours) {
  if (!hours) return "Estimated";
  return `${hours} hrs`;
}

async function getStopCount(itineraryId) {
  const stopsQuery = query(
    collection(db, ITINERARY_STOP_COLLECTION),
    where("itinerary_id", "==", itineraryId)
  );

  const snapshot = await getDocs(stopsQuery);

  return snapshot.size;
}

// ================================
// Load Saved Itineraries
// ================================

async function loadSavedItineraries(user) {
  const savedQuery = query(
    collection(db, ITINERARY_COLLECTION),
    where("user_id", "==", user.uid)
  );

  const snapshot = await getDocs(savedQuery);

  hideLoading();

  if (snapshot.empty) {
    showEmpty();
    return;
  }

  const itineraries = [];

  for (const docSnap of snapshot.docs) {
    const data = docSnap.data();

    const itineraryId =
      data.itinerary_id ||
      docSnap.id;

    const stopCount =
      data.stop_count ||
      await getStopCount(itineraryId);

    itineraries.push({
      id: docSnap.id,
      itinerary_id: itineraryId,
      title: data.title || "Untitled Trip",
      destination: data.destination || "Malaysia",
      date: data.travel_date || "",
      duration: data.available_hours || "",
      stop_count: stopCount,
      status: data.status || "Draft",
      updated_at: data.updated_at || null
    });
  }

  const upcomingPlans = itineraries
    .filter(function (itinerary) {
      return !isPastPlan(itinerary.date);
    })
    .sort(function (a, b) {
      return String(a.date).localeCompare(String(b.date));
    });

  const pastPlans = itineraries
    .filter(function (itinerary) {
      return isPastPlan(itinerary.date);
    })
    .sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date));
    });

  if (upcomingPlans.length) {
    renderItineraries(upcomingPlans, listElement);
    showUpcomingList();
  } else {
    showEmpty();
  }

  if (pastPlans.length) {
    renderItineraries(pastPlans, pastListElement);

    if (pastControl) {
      pastControl.style.display = "block";
    }

    if (togglePastButton) {
      togglePastButton.textContent = `View Past Plans (${pastPlans.length})`;
    }
  }
}

function renderItineraries(itineraries, targetElement) {
  if (!targetElement) return;

  targetElement.innerHTML = "";

  itineraries.forEach(function (itinerary) {
    const status = itinerary.status;
    const badgeClass = getBadgeClass(status);

    const row = document.createElement("div");
    row.className = "saved-row";

    row.innerHTML = `
      <div class="saved-icon">🗓️</div>

      <div class="saved-info">
        <div class="saved-title">
          ${escapeHtml(itinerary.title)}

          <span class="badge ${badgeClass}">
            ${escapeHtml(status)}
          </span>
        </div>

        <div class="saved-meta">
          📍 ${escapeHtml(itinerary.destination)}
          &nbsp;·&nbsp;
          🗓️ ${escapeHtml(formatDate(itinerary.date))}
          &nbsp;·&nbsp;
          ⏱ ${escapeHtml(formatDuration(itinerary.duration))}
          &nbsp;·&nbsp;
          🚩 ${escapeHtml(itinerary.stop_count)} stops
        </div>
      </div>

      <div class="saved-actions">
        <a href="/saved-itineraries/${encodeURIComponent(itinerary.id)}" class="btn btn-secondary btn-sm">
          View
        </a>

        <button type="button" class="btn btn-warning btn-sm js-toggle-publish">
          ${status === "Published" ? "Unpublish" : "Publish"}
        </button>

        <button type="button" class="btn btn-danger btn-sm js-delete-itinerary">
          Delete
        </button>
      </div>
    `;

    const publishButton = row.querySelector(".js-toggle-publish");
    const deleteButton = row.querySelector(".js-delete-itinerary");

    publishButton.addEventListener("click", function () {
      togglePublishStatus(itinerary.id, status);
    });

    deleteButton.addEventListener("click", function () {
      deleteItinerary(itinerary.id, itinerary.itinerary_id);
    });

    targetElement.appendChild(row);
  });
}

// ================================
// Past Plans Toggle
// ================================

if (togglePastButton) {
  togglePastButton.addEventListener("click", function () {
    pastVisible = !pastVisible;

    if (pastSection) {
      pastSection.style.display = pastVisible ? "block" : "none";
    }

    togglePastButton.textContent = pastVisible
      ? "Hide Past Plans"
      : togglePastButton.textContent.replace("Hide", "View");
  });
}

// ================================
// Publish / Unpublish
// ================================

async function togglePublishStatus(documentId, currentStatus) {
  const nextStatus = currentStatus === "Published" ? "Draft" : "Published";

  const updateData = {
    status: nextStatus,
    updated_at: serverTimestamp()
  };

  if (nextStatus === "Published") {
    updateData.published_at = serverTimestamp();
  } else {
    updateData.published_at = null;
  }

  await updateDoc(doc(db, ITINERARY_COLLECTION, documentId), updateData);

  alert("Publish status updated.");
  window.location.reload();
}

// ================================
// Delete
// ================================

async function deleteItinerary(documentId, itineraryId) {
  const confirmed = confirm("Delete this itinerary?");

  if (!confirmed) return;

  const stopsQuery = query(
    collection(db, ITINERARY_STOP_COLLECTION),
    where("itinerary_id", "==", itineraryId)
  );

  const stopsSnapshot = await getDocs(stopsQuery);

  for (const stopDoc of stopsSnapshot.docs) {
    await deleteDoc(doc(db, ITINERARY_STOP_COLLECTION, stopDoc.id));
  }

  await deleteDoc(doc(db, ITINERARY_COLLECTION, documentId));

  alert("Itinerary deleted.");
  window.location.reload();
}

// ================================
// Init
// ================================

onAuthStateChanged(auth, function (user) {
  if (!user) {
    hideLoading();
    showEmpty();
    return;
  }

  loadSavedItineraries(user).catch(function (error) {
    console.error("Failed to load saved itineraries:", error);
    hideLoading();
    showEmpty();
    alert("Failed to load saved itineraries. Please check console.");
  });
});