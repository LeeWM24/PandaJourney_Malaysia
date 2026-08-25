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
  getDoc,
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

let currentUser = null;
let pastVisible = false;
let pastPlanCount = 0;

let pendingDeleteDocumentId = null;
let pendingDeleteItineraryId = null;

// ================================
// Helper
// ================================

function hideLoading() {
  if (loadingElement) {
    loadingElement.style.display = "none";
  }
}

function showLoading() {
  if (loadingElement) {
    loadingElement.style.display = "block";
  }
}

function resetView() {
  if (upcomingSection) {
    upcomingSection.style.display = "none";
  }

  if (emptyElement) {
    emptyElement.style.display = "none";
  }

  if (pastControl) {
    pastControl.style.display = "none";
  }

  if (pastSection) {
    pastSection.style.display = "none";
  }

  if (listElement) {
    listElement.innerHTML = "";
  }

  if (pastListElement) {
    pastListElement.innerHTML = "";
  }

  pastVisible = false;
  pastPlanCount = 0;

  if (togglePastButton) {
    togglePastButton.textContent = "View Past Plans";
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
  if (typeof hours === "string" && /hour|hr|min/i.test(hours)) return hours;
  return `${hours} hrs`;
}

function formatMinutesDuration(minutes) {
  const value = Number(minutes || 0);
  if (!value) return "";
  const hrs = Math.floor(value / 60);
  const mins = value % 60;
  if (hrs && mins) return `${hrs} hr ${mins} min`;
  if (hrs) return `${hrs} hr${hrs === 1 ? "" : "s"}`;
  return `${mins} min`;
}

function getItineraryDate(data) {
  return data.travel_date || data.date || data.trip_date || "";
}

function getItineraryDuration(data) {
  return (
    formatMinutesDuration(data.total_duration_minutes) ||
    formatMinutesDuration(data.travel_duration_minutes) ||
    data.total_duration ||
    data.travel_duration ||
    data.available_hours ||
    ""
  );
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
// Modal UI
// ================================

function openStatusSuccessModal(title, message, icon = "✅") {
  const modal = document.getElementById("status-success-modal");
  const iconElement = document.getElementById("status-success-icon");
  const titleElement = document.getElementById("status-success-title");
  const messageElement = document.getElementById("status-success-message");
  const okButton = document.getElementById("status-success-ok");

  if (!modal) {
    console.log(message || "Action completed successfully.");
    return;
  }

  if (iconElement) {
    iconElement.textContent = icon;
  }

  if (titleElement) {
    titleElement.textContent = title || "Success";
  }

  if (messageElement) {
    messageElement.textContent = message || "Action completed successfully.";
  }

  modal.classList.add("show");
  modal.setAttribute("aria-hidden", "false");

  if (okButton) {
    okButton.focus();
  }
}

function closeStatusSuccessModal() {
  const modal = document.getElementById("status-success-modal");

  if (!modal) return;

  modal.classList.remove("show");
  modal.setAttribute("aria-hidden", "true");
}

function openDeleteConfirmModal(documentId, itineraryId, itineraryTitle = "this itinerary") {
  const modal = document.getElementById("delete-confirm-modal");
  const messageElement = document.getElementById("delete-confirm-message");
  const confirmButton = document.getElementById("confirm-delete-btn");

  pendingDeleteDocumentId = documentId;
  pendingDeleteItineraryId = itineraryId;

  if (!modal) {
    const confirmed = window.confirm("Delete this itinerary? This action cannot be undone.");

    if (confirmed) {
      performDeleteItinerary(documentId, itineraryId).catch(function (error) {
        console.error("Failed to delete itinerary:", error);
      });
    }

    return;
  }

  if (messageElement) {
    messageElement.textContent =
      `Are you sure you want to delete "${itineraryTitle}"? This action cannot be undone.`;
  }

  modal.classList.add("show");
  modal.setAttribute("aria-hidden", "false");

  if (confirmButton) {
    confirmButton.focus();
  }
}

function closeDeleteConfirmModal() {
  const modal = document.getElementById("delete-confirm-modal");

  pendingDeleteDocumentId = null;
  pendingDeleteItineraryId = null;

  if (!modal) return;

  modal.classList.remove("show");
  modal.setAttribute("aria-hidden", "true");
}

function initModalEvents() {
  const statusSuccessOkButton = document.getElementById("status-success-ok");
  const statusSuccessModal = document.getElementById("status-success-modal");

  if (statusSuccessOkButton) {
    statusSuccessOkButton.addEventListener("click", closeStatusSuccessModal);
  }

  if (statusSuccessModal) {
    statusSuccessModal.addEventListener("click", function (event) {
      if (event.target === statusSuccessModal) {
        closeStatusSuccessModal();
      }
    });
  }

  const cancelDeleteButton = document.getElementById("cancel-delete-btn");
  const confirmDeleteButton = document.getElementById("confirm-delete-btn");
  const deleteConfirmModal = document.getElementById("delete-confirm-modal");

  if (cancelDeleteButton) {
    cancelDeleteButton.addEventListener("click", closeDeleteConfirmModal);
  }

  if (confirmDeleteButton) {
    confirmDeleteButton.addEventListener("click", function () {
      if (!pendingDeleteDocumentId || !pendingDeleteItineraryId) return;

      const targetDocumentId = pendingDeleteDocumentId;
      const targetItineraryId = pendingDeleteItineraryId;

      closeDeleteConfirmModal();

      performDeleteItinerary(targetDocumentId, targetItineraryId).catch(function (error) {
        console.error("Failed to delete itinerary:", error);

        openStatusSuccessModal(
          "Delete Failed",
          "The itinerary could not be deleted. Please check the console and try again.",
          "⚠️"
        );
      });
    });
  }

  if (deleteConfirmModal) {
    deleteConfirmModal.addEventListener("click", function (event) {
      if (event.target === deleteConfirmModal) {
        closeDeleteConfirmModal();
      }
    });
  }

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      closeStatusSuccessModal();
      closeDeleteConfirmModal();
    }
  });
}

// ================================
// Load Saved Itineraries
// ================================

async function loadSavedItineraries(user) {
  resetView();

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
      date: getItineraryDate(data),
      duration: getItineraryDuration(data),
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

    pastPlanCount = pastPlans.length;

    if (pastControl) {
      pastControl.style.display = "block";
    }

    if (togglePastButton) {
      togglePastButton.textContent = `View Past Plans (${pastPlanCount})`;
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

    if (publishButton) {
      publishButton.addEventListener("click", function () {
        togglePublishStatus(itinerary.id, status).catch(function (error) {
          console.error("Failed to update publish status:", error);

          openStatusSuccessModal(
            "Update Failed",
            "The publish status could not be updated. Please check the console and try again.",
            "⚠️"
          );
        });
      });
    }

    if (deleteButton) {
      deleteButton.addEventListener("click", function () {
        openDeleteConfirmModal(
          itinerary.id,
          itinerary.itinerary_id,
          itinerary.title || "this itinerary"
        );
      });
    }

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
      : `View Past Plans (${pastPlanCount})`;
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

  if (currentUser) {
    showLoading();
    await loadSavedItineraries(currentUser);
  }

  openStatusSuccessModal(
    "Status Updated",
    nextStatus === "Published"
      ? "This itinerary has been published successfully."
      : "This itinerary has been changed back to draft.",
    "✅"
  );
}

// ================================
// Delete
// ================================

async function performDeleteItinerary(documentId, itineraryId) {
  const savedRef = doc(db, ITINERARY_COLLECTION, documentId);
  const savedSnap = await getDoc(savedRef);

  if (savedSnap.exists()) {
    const savedData = savedSnap.data();
    const sourceItineraryId = savedData.source_itinerary_id;

    if (sourceItineraryId) {
      const originalRef = doc(db, ITINERARY_COLLECTION, sourceItineraryId);
      const originalSnap = await getDoc(originalRef);

      if (originalSnap.exists()) {
        const currentSaves = originalSnap.data().saves ?? 0;

        await updateDoc(originalRef, {
          saves: Math.max(0, currentSaves - 1)
        });
      }
    }
  }

  const stopsQuery = query(
    collection(db, ITINERARY_STOP_COLLECTION),
    where("itinerary_id", "==", itineraryId)
  );

  const stopsSnapshot = await getDocs(stopsQuery);

  for (const stopDoc of stopsSnapshot.docs) {
    await deleteDoc(doc(db, ITINERARY_STOP_COLLECTION, stopDoc.id));
  }

  await deleteDoc(doc(db, ITINERARY_COLLECTION, documentId));

  if (currentUser) {
    showLoading();
    await loadSavedItineraries(currentUser);
  }

  openStatusSuccessModal(
    "Itinerary Deleted",
    "The itinerary has been deleted successfully.",
    "🗑️"
  );
}

// ================================
// Init
// ================================

initModalEvents();

onAuthStateChanged(auth, function (user) {
  currentUser = user;

  if (!user) {
    hideLoading();
    showEmpty();
    return;
  }

  loadSavedItineraries(user).catch(function (error) {
    console.error("Failed to load saved itineraries:", error);
    hideLoading();
    showEmpty();

    openStatusSuccessModal(
      "Load Failed",
      "Failed to load saved itineraries. Please check the console.",
      "⚠️"
    );
  });
});
