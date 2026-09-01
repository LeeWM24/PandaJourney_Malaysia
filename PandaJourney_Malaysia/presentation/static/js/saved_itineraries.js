import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import {
  collection,
  query,
  where,
  getDoc,
  getDocs,
  deleteDoc,
  doc,
  updateDoc,
  setDoc,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

const ITINERARY_COLLECTION = "Itinerary";
const ITINERARY_STOP_COLLECTION = "itinerary_stops";
const COLLABORATOR_COLLECTION = "collaborators";
const NOTIFICATION_COLLECTION = "notifications";

const loadingElement = document.getElementById("saved-loading");
const upcomingSection = document.getElementById("upcoming-section");
const listElement = document.getElementById("saved-list");
const emptyElement = document.getElementById("saved-empty");
const pastControl = document.getElementById("past-control");
const pastSection = document.getElementById("past-section");
const pastListElement = document.getElementById("past-list");
const togglePastButton = document.getElementById("toggle-past-btn");
const sharedControl = document.getElementById("shared-control");
const sharedSection = document.getElementById("shared-section");
const sharedListElement = document.getElementById("shared-list");
const toggleSharedButton = document.getElementById("toggle-shared-btn");
const sharedPastControl = document.getElementById("shared-past-control");
const sharedPastSection = document.getElementById("shared-past-section");
const sharedPastListElement = document.getElementById("shared-past-list");
const toggleSharedPastButton = document.getElementById("toggle-shared-past-btn");
const requestButton = document.getElementById("request-bell-btn");
const requestBadge = document.getElementById("request-count-badge");
const requestPanel = document.getElementById("request-panel");
const requestList = document.getElementById("request-list");

let currentUser = null;
let pastVisible = false;
let sharedVisible = true;
let sharedPastVisible = false;
let pastPlanCount = 0;
let sharedPlanCount = 0;
let sharedPastPlanCount = 0;
let pendingDeleteDocumentId = null;
let pendingDeleteItineraryId = null;

function hideLoading() {
  if (loadingElement) loadingElement.style.display = "none";
}

function showLoading() {
  if (loadingElement) loadingElement.style.display = "block";
}

function resetView() {
  [
    upcomingSection,
    emptyElement,
    pastControl,
    pastSection,
    sharedControl,
    sharedSection,
    sharedPastControl,
    sharedPastSection
  ].forEach(element => {
    if (element) element.style.display = "none";
  });

  [listElement, pastListElement, sharedListElement, sharedPastListElement].forEach(element => {
    if (element) element.innerHTML = "";
  });

  pastVisible = false;
  sharedVisible = true;
  sharedPastVisible = false;
  pastPlanCount = 0;
  sharedPlanCount = 0;
  sharedPastPlanCount = 0;

  if (togglePastButton) togglePastButton.textContent = "View Past Plans";
  if (toggleSharedButton) toggleSharedButton.textContent = "Hide Shared Plans";
  if (toggleSharedPastButton) toggleSharedPastButton.textContent = "View Past Shared Plans";
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
  if (status === "Shared") return "badge-info";
  return "badge-muted";
}

function getTodayDateKey() {
  const today = new Date();
  return [
    today.getFullYear(),
    String(today.getMonth() + 1).padStart(2, "0"),
    String(today.getDate()).padStart(2, "0")
  ].join("-");
}

function isPastPlan(dateText) {
  return dateText ? String(dateText) < getTodayDateKey() : false;
}

function formatDate(dateText) {
  if (!dateText) return "No date";
  const date = new Date(dateText);
  if (Number.isNaN(date.getTime())) return dateText;
  return date.toLocaleDateString("en-MY", { year: "numeric", month: "short", day: "2-digit" });
}

function formatDuration(minutes) {
  const totalMinutes = Number(minutes || 0);
  if (!totalMinutes) return "Estimated";
  const hours = Math.floor(totalMinutes / 60);
  const mins = totalMinutes % 60;
  if (hours && mins) return `${hours} hrs ${mins} mins`;
  if (hours) return `${hours} hrs`;
  return `${mins} mins`;
}

async function getStopSummary(itineraryId, itineraryData = {}) {
  const stopsQuery = query(collection(db, ITINERARY_STOP_COLLECTION), where("itinerary_id", "==", itineraryId));
  const snapshot = await getDocs(stopsQuery);
  let visitMinutes = 0;
  let totalMinutes = 0;
  snapshot.forEach(stopDoc => {
    const stop = stopDoc.data();
    visitMinutes += Number(stop.visit_duration_minutes || 0);
    totalMinutes += Number(stop.travel_minutes_from_previous || 0) + Number(stop.visit_duration_minutes || 0);
  });
  const savedTravelMinutes = Number(itineraryData.travel_duration_minutes || 0);
  if (savedTravelMinutes > 0) {
    totalMinutes = savedTravelMinutes + visitMinutes;
  }
  return {
    count: snapshot.size,
    totalMinutes
  };
}

async function getCollaboratorCount(itineraryId) {
  const collaboratorQuery = query(collection(db, COLLABORATOR_COLLECTION), where("itinerary_id", "==", itineraryId));
  const snapshot = await getDocs(collaboratorQuery);
  return snapshot.size;
}

function normaliseItinerary(docSnap, data, extra = {}) {
  const itineraryId = data.itinerary_id || docSnap.id;
  return {
    id: docSnap.id,
    itinerary_id: itineraryId,
    title: data.title || "Untitled Trip",
    destination: data.destination || "Malaysia",
    date: data.travel_date || "",
    duration_minutes: Number(data.total_duration_minutes || 0),
    stop_count: data.stop_count || 0,
    status: data.status || "Draft",
    owner_id: data.user_id || "",
    collaborator_count: data.collaborator_count || 1,
    ...extra
  };
}

function openStatusSuccessModal(title, message, icon = "✓") {
  const modal = document.getElementById("status-success-modal");
  const iconElement = document.getElementById("status-success-icon");
  const titleElement = document.getElementById("status-success-title");
  const messageElement = document.getElementById("status-success-message");
  const okButton = document.getElementById("status-success-ok");

  if (!modal) {
    console.log(message || "Action completed successfully.");
    return;
  }

  if (iconElement) iconElement.textContent = icon;
  if (titleElement) titleElement.textContent = title || "Success";
  if (messageElement) messageElement.textContent = message || "Action completed successfully.";
  modal.classList.add("show");
  modal.setAttribute("aria-hidden", "false");
  if (okButton) okButton.focus();
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

  if (messageElement) {
    messageElement.textContent = `Are you sure you want to delete "${itineraryTitle}"? This action cannot be undone.`;
  }

  if (!modal) return;
  modal.classList.add("show");
  modal.setAttribute("aria-hidden", "false");
  if (confirmButton) confirmButton.focus();
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
  document.getElementById("status-success-ok")?.addEventListener("click", closeStatusSuccessModal);
  document.getElementById("cancel-delete-btn")?.addEventListener("click", closeDeleteConfirmModal);
  document.getElementById("confirm-delete-btn")?.addEventListener("click", function () {
    if (!pendingDeleteDocumentId || !pendingDeleteItineraryId) return;
    const targetDocumentId = pendingDeleteDocumentId;
    const targetItineraryId = pendingDeleteItineraryId;
    closeDeleteConfirmModal();
    performDeleteItinerary(targetDocumentId, targetItineraryId).catch(error => {
      console.error("Failed to delete itinerary:", error);
      openStatusSuccessModal("Delete Failed", "The itinerary could not be deleted.", "!");
    });
  });
}

async function loadOwnedItineraries(user) {
  const savedQuery = query(collection(db, ITINERARY_COLLECTION), where("user_id", "==", user.uid));
  const snapshot = await getDocs(savedQuery);
  const itineraries = [];

  for (const docSnap of snapshot.docs) {
    const data = docSnap.data();
    const itinerary = normaliseItinerary(docSnap, data);
    const stopSummary = await getStopSummary(itinerary.itinerary_id, data);
    itinerary.stop_count = itinerary.stop_count || stopSummary.count;
    itinerary.duration_minutes = stopSummary.totalMinutes || itinerary.duration_minutes;
    itinerary.collaborator_count = await getCollaboratorCount(itinerary.itinerary_id) || 1;
    itineraries.push(itinerary);
  }

  return itineraries;
}

async function loadSharedItineraries(user) {
  const collaboratorQuery = query(
    collection(db, COLLABORATOR_COLLECTION),
    where("user_id", "==", user.uid),
    where("status", "==", "accepted")
  );
  const collaboratorSnapshot = await getDocs(collaboratorQuery);
  const shared = [];

  for (const collaboratorDoc of collaboratorSnapshot.docs) {
    const collaborator = collaboratorDoc.data();
    if (collaborator.owner_id === user.uid || collaborator.role === "owner") continue;

    const itineraryDocId = collaborator.itinerary_document_id || collaborator.itinerary_id;
    const itinerarySnap = await getDoc(doc(db, ITINERARY_COLLECTION, itineraryDocId));
    if (!itinerarySnap.exists()) continue;
    if (itinerarySnap.data().user_id === user.uid) continue;

    const itinerary = normaliseItinerary(itinerarySnap, itinerarySnap.data(), {
      role: collaborator.role || "viewer",
      collaborator_document_id: collaboratorDoc.id,
      shared: true
    });
    const stopSummary = await getStopSummary(itinerary.itinerary_id, itinerarySnap.data());
    itinerary.stop_count = itinerary.stop_count || stopSummary.count;
    itinerary.duration_minutes = stopSummary.totalMinutes || itinerary.duration_minutes;
    itinerary.collaborator_count = await getCollaboratorCount(itinerary.itinerary_id) || 1;
    shared.push(itinerary);
  }

  return shared;
}

async function loadPendingRequests(user) {
  const email = String(user.email || "").toLowerCase();
  const snapshots = await Promise.all(["pending", "pending_registration"].map(status => {
    const requestQuery = query(
      collection(db, COLLABORATOR_COLLECTION),
      where("email", "==", email),
      where("status", "==", status)
    );
    return getDocs(requestQuery);
  }));
  const requests = [];

  for (const snapshot of snapshots) {
    for (const requestDoc of snapshot.docs) {
      const request = requestDoc.data();
      const itineraryDocId = request.itinerary_document_id || request.itinerary_id;
      const itinerarySnap = await getDoc(doc(db, ITINERARY_COLLECTION, itineraryDocId));
      if (!itinerarySnap.exists()) continue;

      const itinerary = normaliseItinerary(itinerarySnap, itinerarySnap.data());
      const stopSummary = await getStopSummary(itinerary.itinerary_id, itinerarySnap.data());
      itinerary.stop_count = itinerary.stop_count || stopSummary.count;
      itinerary.duration_minutes = stopSummary.totalMinutes || itinerary.duration_minutes;
      itinerary.collaborator_count = await getCollaboratorCount(itinerary.itinerary_id) || 1;
      requests.push({ id: requestDoc.id, ...request, itinerary });
    }
  }

  return requests;
}

async function loadSavedItineraries(user) {
  resetView();
  const [ownedItineraries, sharedItineraries, requests] = await Promise.all([
    loadOwnedItineraries(user),
    loadSharedItineraries(user),
    loadPendingRequests(user)
  ]);

  hideLoading();
  renderRequests(requests);

  const upcomingPlans = ownedItineraries.filter(item => !isPastPlan(item.date)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const pastPlans = ownedItineraries.filter(item => isPastPlan(item.date)).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const upcomingShared = sharedItineraries.filter(item => !isPastPlan(item.date)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const pastShared = sharedItineraries.filter(item => isPastPlan(item.date)).sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const hasAnyPlans = upcomingPlans.length || pastPlans.length || upcomingShared.length || pastShared.length;

  if (upcomingPlans.length) {
    renderItineraries(upcomingPlans, listElement, "owned");
    if (upcomingSection) upcomingSection.style.display = "block";
  } else if (emptyElement && !hasAnyPlans) {
    emptyElement.style.display = "block";
  }

  if (pastPlans.length) {
    renderItineraries(pastPlans, pastListElement, "owned");
    pastPlanCount = pastPlans.length;
    if (pastControl) pastControl.style.display = "block";
    if (togglePastButton) togglePastButton.textContent = `View Past Plans (${pastPlanCount})`;
  }

  if (upcomingShared.length) {
    renderItineraries(upcomingShared, sharedListElement, "shared");
    sharedPlanCount = upcomingShared.length;
    if (sharedControl) sharedControl.style.display = "block";
    if (sharedSection) sharedSection.style.display = "block";
    if (toggleSharedButton) toggleSharedButton.textContent = "Hide Shared Plans";
  }

  if (pastShared.length) {
    renderItineraries(pastShared, sharedPastListElement, "shared");
    sharedPastPlanCount = pastShared.length;
    if (sharedPastControl) sharedPastControl.style.display = "block";
    if (toggleSharedPastButton) toggleSharedPastButton.textContent = `View Past Shared Plans (${sharedPastPlanCount})`;
  }
}

function renderItineraries(itineraries, targetElement, listType) {
  if (!targetElement) return;
  targetElement.innerHTML = "";

  itineraries.forEach(itinerary => {
    const status = listType === "shared" ? "Shared" : itinerary.status;
    const canEdit = listType === "owned" || ["owner", "editor"].includes(String(itinerary.role || "").toLowerCase());
    const badgeClass = getBadgeClass(status);
    const row = document.createElement("div");
    row.className = "saved-row";
    row.innerHTML = `
      <div class="saved-icon">🗓️</div>
      <div class="saved-info">
        <div class="saved-title">
          ${escapeHtml(itinerary.title)}
          <span class="badge ${badgeClass}">${escapeHtml(status)}</span>
        </div>
        <div class="saved-meta">
          ${escapeHtml(formatDate(itinerary.date))}
          &nbsp;-&nbsp; ${escapeHtml(formatDuration(itinerary.duration_minutes))}
          &nbsp;-&nbsp; ${escapeHtml(itinerary.stop_count)} stops
          &nbsp;-&nbsp; ${escapeHtml(itinerary.collaborator_count)} people
        </div>
      </div>
      <div class="saved-actions">
        <a href="/saved-itineraries/${encodeURIComponent(itinerary.id)}" class="btn btn-secondary btn-sm">View</a>
        ${canEdit ? `<a href="/saved-itineraries/${encodeURIComponent(itinerary.id)}/edit" class="btn btn-secondary btn-sm">Edit</a>` : ""}
        ${listType === "owned" ? `<button type="button" class="btn btn-warning btn-sm js-toggle-publish">${itinerary.status === "Published" ? "Unpublish" : "Publish"}</button>` : ""}
        ${listType === "owned" ? `<button type="button" class="btn btn-danger btn-sm js-delete-itinerary">Delete</button>` : ""}
      </div>
    `;

    row.querySelector(".js-toggle-publish")?.addEventListener("click", function () {
      togglePublishStatus(itinerary.id, itinerary.status).catch(error => {
        console.error("Failed to update publish status:", error);
        openStatusSuccessModal("Update Failed", "The publish status could not be updated.", "!");
      });
    });

    row.querySelector(".js-delete-itinerary")?.addEventListener("click", function () {
      openDeleteConfirmModal(itinerary.id, itinerary.itinerary_id, itinerary.title || "this itinerary");
    });

    targetElement.appendChild(row);
  });
}

function renderRequests(requests) {
  if (requestBadge) {
    requestBadge.textContent = String(requests.length);
    requestBadge.style.display = requests.length ? "inline-flex" : "none";
  }

  if (!requestList) return;
  if (!requests.length) {
    requestList.innerHTML = `<div class="request-empty">No pending requests.</div>`;
    return;
  }

  requestList.innerHTML = "";
  requests.forEach(request => {
    const item = document.createElement("div");
    item.className = "request-item";
    item.innerHTML = `
      <div class="request-title">${escapeHtml(request.invited_by_name || request.owner_email || "Someone")} invited you</div>
      <div class="request-meta">${escapeHtml(request.itinerary.title)} - ${escapeHtml(formatDate(request.itinerary.date))}</div>
      <div class="request-meta">${escapeHtml(request.itinerary.stop_count)} stops - ${escapeHtml(request.itinerary.collaborator_count)} people</div>
      <div class="request-actions">
        <button type="button" class="btn btn-primary btn-sm js-accept-request">Accept</button>
        <button type="button" class="btn btn-secondary btn-sm js-decline-request">Decline</button>
      </div>
    `;

    item.querySelector(".js-accept-request")?.addEventListener("click", function () {
      acceptRequest(request).catch(error => {
        console.error("Failed to accept request:", error);
        openStatusSuccessModal("Request Failed", "Could not accept this request.", "!");
      });
    });
    item.querySelector(".js-decline-request")?.addEventListener("click", function () {
      declineRequest(request).catch(error => {
        console.error("Failed to decline request:", error);
        openStatusSuccessModal("Request Failed", "Could not decline this request.", "!");
      });
    });

    requestList.appendChild(item);
  });
}

async function acceptRequest(request) {
  await updateDoc(doc(db, COLLABORATOR_COLLECTION, request.id), {
    user_id: currentUser.uid,
    email: String(currentUser.email || "").toLowerCase(),
    status: "accepted",
    accepted_at: serverTimestamp(),
    updated_at: serverTimestamp()
  });

  const notificationRef = doc(collection(db, NOTIFICATION_COLLECTION));
  await setDoc(notificationRef, {
    notification_id: notificationRef.id,
    itinerary_id: request.itinerary.itinerary_id,
    itinerary_document_id: request.itinerary.id,
    actor_id: currentUser.uid,
    actor_name: currentUser.displayName || currentUser.email || "A collaborator",
    type: "request_accepted",
    message: `${currentUser.displayName || currentUser.email || "A collaborator"} accepted the invitation`,
    created_at: serverTimestamp()
  });

  showLoading();
  await loadSavedItineraries(currentUser);
  openStatusSuccessModal("Request Accepted", "The shared itinerary is now shown in Shared Plans.", "✓");
}

async function declineRequest(request) {
  await updateDoc(doc(db, COLLABORATOR_COLLECTION, request.id), {
    status: "declined",
    declined_at: serverTimestamp(),
    updated_at: serverTimestamp()
  });
  showLoading();
  await loadSavedItineraries(currentUser);
}

togglePastButton?.addEventListener("click", function () {
  pastVisible = !pastVisible;
  if (pastSection) pastSection.style.display = pastVisible ? "block" : "none";
  togglePastButton.textContent = pastVisible ? "Hide Past Plans" : `View Past Plans (${pastPlanCount})`;
});

toggleSharedButton?.addEventListener("click", function () {
  sharedVisible = !sharedVisible;
  if (sharedSection) sharedSection.style.display = sharedVisible ? "block" : "none";
  toggleSharedButton.textContent = sharedVisible ? "Hide Shared Plans" : `Shared Plans (${sharedPlanCount})`;
});

toggleSharedPastButton?.addEventListener("click", function () {
  sharedPastVisible = !sharedPastVisible;
  if (sharedPastSection) sharedPastSection.style.display = sharedPastVisible ? "block" : "none";
  toggleSharedPastButton.textContent = sharedPastVisible ? "Hide Past Shared Plans" : `View Past Shared Plans (${sharedPastPlanCount})`;
});

if (requestButton && requestPanel) {
  requestButton.addEventListener("click", function () {
    requestPanel.classList.toggle("show");
  });
  document.addEventListener("click", function (event) {
    if (!requestPanel.contains(event.target) && !requestButton.contains(event.target)) {
      requestPanel.classList.remove("show");
    }
  });
}

async function togglePublishStatus(documentId, currentStatus) {
  const nextStatus = currentStatus === "Published" ? "Draft" : "Published";
  await updateDoc(doc(db, ITINERARY_COLLECTION, documentId), {
    status: nextStatus,
    updated_at: serverTimestamp(),
    published_at: nextStatus === "Published" ? serverTimestamp() : null
  });

  if (currentUser) {
    showLoading();
    await loadSavedItineraries(currentUser);
  }

  openStatusSuccessModal(
    "Status Updated",
    nextStatus === "Published" ? "This itinerary has been published successfully." : "This itinerary has been changed back to draft.",
    "✓"
  );
}

async function performDeleteItinerary(documentId, itineraryId) {
  const savedRef = doc(db, ITINERARY_COLLECTION, documentId);
  const savedSnap = await getDoc(savedRef);

  if (savedSnap.exists()) {
    const sourceItineraryId = savedSnap.data().source_itinerary_id;
    if (sourceItineraryId) {
      const originalRef = doc(db, ITINERARY_COLLECTION, sourceItineraryId);
      const originalSnap = await getDoc(originalRef);
      if (originalSnap.exists()) {
        const currentSaves = originalSnap.data().saves ?? 0;
        await updateDoc(originalRef, { saves: Math.max(0, currentSaves - 1) });
      }
    }
  }

  const stopsQuery = query(collection(db, ITINERARY_STOP_COLLECTION), where("itinerary_id", "==", itineraryId));
  const stopsSnapshot = await getDocs(stopsQuery);
  for (const stopDoc of stopsSnapshot.docs) {
    await deleteDoc(doc(db, ITINERARY_STOP_COLLECTION, stopDoc.id));
  }

  await deleteDoc(doc(db, ITINERARY_COLLECTION, documentId));

  if (currentUser) {
    showLoading();
    await loadSavedItineraries(currentUser);
  }

  openStatusSuccessModal("Itinerary Deleted", "The itinerary has been deleted successfully.", "✓");
}

initModalEvents();

onAuthStateChanged(auth, function (user) {
  currentUser = user;
  if (!user) {
    hideLoading();
    if (emptyElement) emptyElement.style.display = "block";
    return;
  }

  loadSavedItineraries(user).catch(error => {
    console.error("Failed to load saved itineraries:", error);
    hideLoading();
    if (emptyElement) emptyElement.style.display = "block";
    openStatusSuccessModal("Load Failed", "Failed to load saved itineraries.", "!");
  });
});
