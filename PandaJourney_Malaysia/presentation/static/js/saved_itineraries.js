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
const listElement = document.getElementById("saved-list");
const emptyElement = document.getElementById("saved-empty");

// ================================
// Helper
// ================================

function hideLoading() {
  if (loadingElement) {
    loadingElement.style.display = "none";
  }
}

function showEmpty() {
  if (listElement) {
    listElement.style.display = "none";
  }

  if (emptyElement) {
    emptyElement.style.display = "block";
  }
}

function showList() {
  if (emptyElement) {
    emptyElement.style.display = "none";
  }

  if (listElement) {
    listElement.style.display = "block";
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

  itineraries.sort(function (a, b) {
    const aTime = a.updated_at?.toMillis ? a.updated_at.toMillis() : 0;
    const bTime = b.updated_at?.toMillis ? b.updated_at.toMillis() : 0;

    return bTime - aTime;
  });

  renderItineraries(itineraries);
}

function renderItineraries(itineraries) {
  if (!listElement) return;

  listElement.innerHTML = "";

  itineraries.forEach(function (itinerary) {
    const status = itinerary.status;
    const badgeClass = getBadgeClass(status);

    const row = document.createElement("div");
    row.className = "saved-row";

    row.innerHTML = `
      <div class="saved-icon">📅</div>

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
          📆 ${escapeHtml(formatDate(itinerary.date))}
          &nbsp;·&nbsp;
          ⏱ ${escapeHtml(formatDuration(itinerary.duration))}
          &nbsp;·&nbsp;
          🚩 ${escapeHtml(itinerary.stop_count)} stops
        </div>
      </div>

      <div class="saved-actions">
        <a href="/smart-itinerary?id=${encodeURIComponent(itinerary.itinerary_id)}" class="btn btn-secondary btn-sm">
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

    listElement.appendChild(row);
  });

  showList();
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