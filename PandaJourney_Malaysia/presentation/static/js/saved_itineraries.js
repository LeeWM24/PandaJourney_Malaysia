import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import {
  collection,
  query,
  where,
  orderBy,
  startAt,
  endAt,
  getDoc,
  getDocs,
  limit,
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
const inviteModal = document.getElementById("invite-modal");
const inviteTitle = document.getElementById("invite-title");
const inviteForm = document.getElementById("saved-invite-form");
const inviteEmailInput = document.getElementById("saved-invite-email");
const inviteMessage = document.getElementById("saved-invite-message");
const inviteOptions = document.getElementById("saved-invite-options");
const inviteSuggestions = document.getElementById("saved-invite-suggestions");
const sendInviteEmailButton = document.getElementById("saved-send-invite-email");
const copyInviteLinkButton = document.getElementById("saved-copy-invite-link");
const closeInviteButton = document.getElementById("close-invite-btn");
const peopleModal = document.getElementById("people-modal");
const peopleTitle = document.getElementById("people-title");
const peopleList = document.getElementById("people-list");
const closePeopleButton = document.getElementById("close-people-btn");

let currentUser = null;
let pastVisible = false;
let sharedVisible = true;
let sharedPastVisible = false;
let pastPlanCount = 0;
let sharedPlanCount = 0;
let sharedPastPlanCount = 0;
let pendingDeleteDocumentId = null;
let pendingDeleteItineraryId = null;
let pendingInviteItinerary = null;
let pendingInviteLink = "";
let pendingInviteEmail = "";
let inviteSearchTimer = null;
let activityCollaboratorDocs = [];
const userProfileCache = new Map();

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

function timestampMillis(value) {
  if (!value) return 0;
  if (value.toMillis) return value.toMillis();
  if (value.toDate) return value.toDate().getTime();
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function formatRelativeTime(value) {
  const time = timestampMillis(value);
  if (!time) return "";

  const seconds = Math.max(1, Math.floor((Date.now() - time) / 1000));
  if (seconds < 60) return "Just now";

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;

  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

async function getStopSummary(itineraryId, itineraryData = {}) {
  try {
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
  } catch (error) {
    console.warn("Could not load stop summary:", error);
    return {
      count: Number(itineraryData.stop_count || 0),
      totalMinutes: Number(itineraryData.total_duration_minutes || 0)
    };
  }
}

async function getCollaboratorCount(itineraryId) {
  try {
    const collaboratorQuery = query(collection(db, COLLABORATOR_COLLECTION), where("itinerary_id", "==", itineraryId));
    const snapshot = await getDocs(collaboratorQuery);
    return snapshot.size;
  } catch (error) {
    console.warn("Could not load collaborator count:", error);
    return 1;
  }
}

async function getUserProfile(userId) {
  if (!userId) return null;
  if (userProfileCache.has(userId)) return userProfileCache.get(userId);

  try {
    const snapshot = await getDoc(doc(db, "users", userId));
    const profile = snapshot.exists() ? snapshot.data() : null;
    userProfileCache.set(userId, profile);
    return profile;
  } catch (error) {
    console.error("Failed to load user profile:", error);
    userProfileCache.set(userId, null);
    return null;
  }
}

async function getCollaboratorDetails(itineraryId, ownerId) {
  let snapshot;
  try {
    const collaboratorQuery = query(collection(db, COLLABORATOR_COLLECTION), where("itinerary_id", "==", itineraryId));
    snapshot = await getDocs(collaboratorQuery);
  } catch (error) {
    console.warn("Could not load collaborator details:", error);
    snapshot = { forEach: function () {} };
  }
  const collaborators = [];

  snapshot.forEach(item => {
    collaborators.push({
      document_id: item.id,
      ...item.data()
    });
  });

  await Promise.all(collaborators.map(async function (collaborator) {
    if (!collaborator.user_id) return;
    const profile = await getUserProfile(collaborator.user_id);
    if (!profile) return;

    collaborator.display_name = collaborator.display_name || profile.displayName || profile.display_name || profile.name || "";
    collaborator.email = collaborator.email || profile.email || "";
  }));

  const hasOwnerCollaborator = collaborators.some(item => {
    return item.user_id === ownerId || item.role === "owner";
  });

  if (!hasOwnerCollaborator && ownerId) {
    const profile = await getUserProfile(ownerId);
    collaborators.unshift({
      user_id: ownerId,
      email: profile?.email || "",
      display_name: profile?.displayName || profile?.display_name || profile?.name || "Owner",
      role: "owner",
      status: "accepted"
    });
  }

  return dedupeCollaborators(collaborators);
}

async function getItineraryByReferenceIds(referenceIds) {
  const uniqueIds = [...new Set(referenceIds.filter(Boolean))];

  for (const referenceId of uniqueIds) {
    try {
      const directSnap = await getDoc(doc(db, ITINERARY_COLLECTION, referenceId));
      if (directSnap.exists()) return directSnap;
    } catch (error) {
      console.warn("Direct itinerary lookup failed:", error);
    }

    try {
      const itineraryQuery = query(
        collection(db, ITINERARY_COLLECTION),
        where("itinerary_id", "==", referenceId),
        limit(1)
      );
      const querySnap = await getDocs(itineraryQuery);
      if (!querySnap.empty) return querySnap.docs[0];
    } catch (error) {
      console.warn("Itinerary id lookup failed:", error);
    }
  }

  return null;
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

function normaliseEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function isValidInviteEmail(email) {
  return /^[^\s@/]+@[^\s@/]+\.[^\s@/]{2,}$/.test(normaliseEmail(email));
}

function notificationDocumentId(itineraryDocumentId, type, key) {
  const safeKey = String(key || "")
    .toLowerCase()
    .replace(/[^a-z0-9@._-]+/g, "_");
  return `${itineraryDocumentId}_${type}_${safeKey}`;
}

function dedupeNotifications(notifications) {
  const unique = new Map();

  notifications.forEach(notification => {
    const key = notification.type === "invite_sent"
      ? `${notification.itinerary_id}|${notification.type}|${notification.actor_id}|${notification.message}`
      : notification.document_id;

    if (!key) return;
    const existing = unique.get(key);
    if (!existing || timestampMillis(notification.created_at) >= timestampMillis(existing.created_at)) {
      unique.set(key, notification);
    }
  });

  return [...unique.values()];
}

function collaboratorDocumentId(itineraryDocumentId, userId) {
  return `${itineraryDocumentId}_${userId}`;
}

function pendingInviteDocumentId(itineraryDocumentId, email) {
  return `${itineraryDocumentId}_invite_${normaliseEmail(email)}`;
}

function collaboratorKey(collaborator) {
  return collaborator.user_id || normaliseEmail(collaborator.email) || collaborator.document_id || "";
}

function collaboratorRank(collaborator) {
  const roleRanks = { owner: 30, editor: 20, viewer: 10 };
  const statusRanks = { accepted: 3, pending: 2, pending_registration: 1, declined: 0 };
  const role = String(collaborator.role || "viewer").toLowerCase();
  const status = String(collaborator.status || "accepted").toLowerCase();
  return (roleRanks[role] || 0) + (statusRanks[status] || 0);
}

function dedupeCollaborators(collaborators) {
  const unique = new Map();

  collaborators.forEach(collaborator => {
    const key = collaboratorKey(collaborator);
    if (!key) return;

    const existing = unique.get(key);
    if (!existing || collaboratorRank(collaborator) >= collaboratorRank(existing)) {
      unique.set(key, collaborator);
    }
  });

  return [...unique.values()];
}

function currentUserDisplayName() {
  return currentUser?.displayName || currentUser?.email || "A collaborator";
}

function setInviteMessage(message, isError = false) {
  if (!inviteMessage) return;
  inviteMessage.textContent = message || "";
  inviteMessage.classList.toggle("error", Boolean(isError));
}

function clearInviteSuggestions() {
  if (!inviteSuggestions) return;
  inviteSuggestions.innerHTML = "";
  inviteSuggestions.classList.remove("show");
}

function renderInviteSuggestions(users) {
  if (!inviteSuggestions) return;

  const eligibleUsers = users.filter(user => {
    const email = normaliseEmail(user.email);
    return email && email !== normaliseEmail(currentUser?.email);
  });

  if (!eligibleUsers.length) {
    clearInviteSuggestions();
    return;
  }

  inviteSuggestions.innerHTML = "";
  eligibleUsers.forEach(user => {
    const name = String(user.displayName || user.email || "PandaJourney user").trim();
    const option = document.createElement("button");
    option.type = "button";
    option.className = "saved-invite-suggestion";
    option.innerHTML = `
      <span class="saved-invite-suggestion-name">${escapeHtml(name)}</span>
      <span class="saved-invite-suggestion-email">${escapeHtml(user.email || "")}</span>
    `;
    option.addEventListener("click", function () {
      if (inviteEmailInput) inviteEmailInput.value = normaliseEmail(user.email);
      clearInviteSuggestions();
      inviteEmailInput?.focus();
    });
    inviteSuggestions.appendChild(option);
  });
  inviteSuggestions.classList.add("show");
}

async function searchInviteUsers(searchTerm) {
  const prefix = normaliseEmail(searchTerm);

  if (prefix.length < 2) {
    clearInviteSuggestions();
    return;
  }

  try {
    const usersQuery = query(
      collection(db, "users"),
      orderBy("email"),
      startAt(prefix),
      endAt(`${prefix}\uf8ff`),
      limit(6)
    );
    const snapshot = await getDocs(usersQuery);

    if (prefix !== normaliseEmail(inviteEmailInput?.value)) return;

    renderInviteSuggestions(snapshot.docs.map(item => ({
      id: item.id,
      ...item.data()
    })));
  } catch (error) {
    console.error("Invite user search failed:", error);
    clearInviteSuggestions();
  }
}

function openInviteModal(itinerary) {
  pendingInviteItinerary = itinerary;
  pendingInviteLink = "";
  pendingInviteEmail = "";
  if (inviteTitle) inviteTitle.textContent = `Invite people to ${itinerary.title || "this itinerary"}`;
  if (inviteEmailInput) inviteEmailInput.value = "";
  if (inviteOptions) inviteOptions.classList.remove("show");
  clearInviteSuggestions();
  setInviteMessage("");
  inviteModal?.classList.add("show");
  inviteModal?.setAttribute("aria-hidden", "false");
  inviteEmailInput?.focus();
}

function closeInviteModal() {
  pendingInviteItinerary = null;
  pendingInviteLink = "";
  pendingInviteEmail = "";
  clearInviteSuggestions();
  inviteModal?.classList.remove("show");
  inviteModal?.setAttribute("aria-hidden", "true");
}

function collaboratorName(collaborator) {
  const savedName = String(collaborator.display_name || "").trim();
  const email = String(collaborator.email || "").trim();

  if (savedName && savedName !== email) return savedName;
  return email ? email.split("@")[0] : "Invited person";
}

function getPeopleStatusLabel(status) {
  if (status === "pending_registration") return "Waiting to join";
  if (status === "pending") return "Request sent";
  if (status === "accepted") return "Joined";
  if (status === "declined") return "Declined";
  return status || "Unknown";
}

function openPeopleModal(itinerary) {
  if (peopleTitle) peopleTitle.textContent = `People in ${itinerary.title || "this itinerary"}`;

  const collaborators = dedupeCollaborators(itinerary.collaborators || []);

  if (peopleList) {
    if (!collaborators.length) {
      peopleList.innerHTML = `<div class="request-empty">No people found.</div>`;
    } else {
      peopleList.innerHTML = collaborators.map(collaborator => {
        const role = String(collaborator.role || "viewer").toLowerCase();
        const status = String(collaborator.status || "accepted").toLowerCase();
        return `
          <div class="people-row">
            <div class="people-avatar">${escapeHtml(collaboratorName(collaborator).charAt(0).toUpperCase() || "?")}</div>
            <div class="people-info">
              <div class="people-name">${escapeHtml(collaboratorName(collaborator))}</div>
              <div class="people-email">${escapeHtml(collaborator.email || "")}</div>
            </div>
            <div class="people-tags">
              <span class="badge badge-muted">${escapeHtml(role)}</span>
              <span class="badge ${status === "accepted" ? "badge-success" : status === "declined" ? "badge-muted" : "badge-warning"}">${escapeHtml(getPeopleStatusLabel(status))}</span>
            </div>
          </div>
        `;
      }).join("");
    }
  }

  peopleModal?.classList.add("show");
  peopleModal?.setAttribute("aria-hidden", "false");
  closePeopleButton?.focus();
}

function closePeopleModal() {
  peopleModal?.classList.remove("show");
  peopleModal?.setAttribute("aria-hidden", "true");
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
  closeInviteButton?.addEventListener("click", closeInviteModal);
  inviteModal?.addEventListener("click", function (event) {
    if (event.target === inviteModal) closeInviteModal();
  });
  closePeopleButton?.addEventListener("click", closePeopleModal);
  peopleModal?.addEventListener("click", function (event) {
    if (event.target === peopleModal) closePeopleModal();
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
    itinerary.collaborators = await getCollaboratorDetails(itinerary.itinerary_id, itinerary.owner_id);
    itinerary.collaborator_count = itinerary.collaborators.length || 1;
    itineraries.push(itinerary);
  }

  return itineraries;
}

async function findRegisteredUserByEmail(email) {
  const userQuery = query(
    collection(db, "users"),
    where("email", "==", email),
    limit(1)
  );
  const snapshot = await getDocs(userQuery);
  if (snapshot.empty) return null;
  return {
    id: snapshot.docs[0].id,
    ...snapshot.docs[0].data()
  };
}

async function inviteCollaboratorFromList(email) {
  if (!currentUser || !pendingInviteItinerary) return;

  const itinerary = pendingInviteItinerary;
  const existingQuery = query(
    collection(db, COLLABORATOR_COLLECTION),
    where("itinerary_id", "==", itinerary.itinerary_id),
    where("email", "==", email)
  );
  const existingSnapshot = await getDocs(existingQuery);

  if (!existingSnapshot.empty) {
    setInviteMessage("This person is already invited or added.", true);
    return;
  }

  const registeredUser = await findRegisteredUserByEmail(email);

const collaboratorId = registeredUser
  ? collaboratorDocumentId(itinerary.id, registeredUser.id)
  : pendingInviteDocumentId(itinerary.id, email);

const collaboratorRef = doc(
  db,
  COLLABORATOR_COLLECTION,
  collaboratorId
);

const inviterName = currentUserDisplayName();

  await setDoc(collaboratorRef, {
    collaborator_id: collaboratorRef.id,
    itinerary_id: itinerary.itinerary_id,
    itinerary_document_id: itinerary.id,
    owner_id: itinerary.owner_id,
    owner_email: normaliseEmail(currentUser.email),
    invited_by: currentUser.uid,
    invited_by_name: inviterName,
    email,
    display_name: registeredUser?.displayName || registeredUser?.display_name || registeredUser?.name || "",
    role: "viewer",
    status: registeredUser ? "pending" : "pending_registration",
    user_id: registeredUser ? registeredUser.id : "",
    created_at: serverTimestamp(),
    updated_at: serverTimestamp()
  });

  const notificationRef = doc(
    db,
    NOTIFICATION_COLLECTION,
    notificationDocumentId(itinerary.id, "invite_sent", email)
  );
  await setDoc(notificationRef, {
    notification_id: notificationRef.id,
    itinerary_id: itinerary.itinerary_id,
    itinerary_document_id: itinerary.id,
    actor_id: currentUser.uid,
    actor_name: inviterName,
    type: "invite_sent",
    message: `${inviterName} invited ${email}`,
    created_at: serverTimestamp()
  });

  if (registeredUser) {
    setInviteMessage("Invitation request sent. It will show in their requests.");
    if (inviteOptions) inviteOptions.classList.remove("show");
  } else {
    pendingInviteEmail = email;
    pendingInviteLink = `${window.location.origin}/saved-itineraries/${encodeURIComponent(itinerary.id)}/edit?invite=${encodeURIComponent(collaboratorRef.id)}`;
    setInviteMessage("This email is not registered yet. Send or copy the joining link.");
    if (inviteOptions) inviteOptions.classList.add("show");
  }

  showLoading();
  await loadSavedItineraries(currentUser);
}

async function loadSharedItineraries(user) {
  let collaboratorSnapshot;
  try {
    const collaboratorQuery = query(
      collection(db, COLLABORATOR_COLLECTION),
      where("user_id", "==", user.uid),
      where("status", "==", "accepted")
    );
    collaboratorSnapshot = await getDocs(collaboratorQuery);
  } catch (error) {
    console.warn("Could not load shared itinerary records:", error);
    return [];
  }
  const shared = [];

  for (const collaboratorDoc of collaboratorSnapshot.docs) {
    try {
      const collaborator = collaboratorDoc.data();
      if (collaborator.owner_id === user.uid || collaborator.role === "owner") continue;

      const itinerarySnap = await getItineraryByReferenceIds([
        collaborator.itinerary_document_id,
        collaborator.itinerary_id
      ]);
      if (!itinerarySnap || !itinerarySnap.exists()) continue;
      if (itinerarySnap.data().user_id === user.uid) continue;

      const itinerary = normaliseItinerary(itinerarySnap, itinerarySnap.data(), {
        role: collaborator.role || "viewer",
        collaborator_document_id: collaboratorDoc.id,
        shared: true
      });
      const stopSummary = await getStopSummary(itinerary.itinerary_id, itinerarySnap.data());
      itinerary.stop_count = itinerary.stop_count || stopSummary.count;
      itinerary.duration_minutes = stopSummary.totalMinutes || itinerary.duration_minutes;
      itinerary.collaborators = await getCollaboratorDetails(itinerary.itinerary_id, itinerary.owner_id);
      itinerary.collaborator_count = itinerary.collaborators.length || 1;
      shared.push(itinerary);
    } catch (error) {
      console.warn("Skipping unreadable shared itinerary:", error);
    }
  }

  return shared;
}

async function loadPendingRequests(user) {
  const email = String(user.email || "").toLowerCase();
  let snapshots;
  try {
    snapshots = await Promise.all(["pending", "pending_registration"].map(status => {
      const requestQuery = query(
        collection(db, COLLABORATOR_COLLECTION),
        where("email", "==", email),
        where("status", "==", status)
      );
      return getDocs(requestQuery);
    }));
  } catch (error) {
    console.warn("Could not load pending itinerary requests:", error);
    return [];
  }
  const requests = [];

  for (const snapshot of snapshots) {
    for (const requestDoc of snapshot.docs) {
      try {
        const request = requestDoc.data();
        const itinerarySnap = await getItineraryByReferenceIds([
          request.itinerary_document_id,
          request.itinerary_id
        ]);
        if (!itinerarySnap || !itinerarySnap.exists()) continue;

        const itinerary = normaliseItinerary(itinerarySnap, itinerarySnap.data());
        const stopSummary = await getStopSummary(itinerary.itinerary_id, itinerarySnap.data());
        itinerary.stop_count = itinerary.stop_count || stopSummary.count;
        itinerary.duration_minutes = stopSummary.totalMinutes || itinerary.duration_minutes;
        itinerary.collaborator_count = await getCollaboratorCount(itinerary.itinerary_id) || 1;
        requests.push({ id: requestDoc.id, ...request, itinerary });
      } catch (error) {
        console.warn("Skipping unreadable itinerary request:", error);
      }
    }
  }

  return requests;
}

async function loadActivityNotifications(ownedItineraries, sharedItineraries) {
  const accessibleItineraries = [...ownedItineraries, ...sharedItineraries];

  activityCollaboratorDocs = [];

  try {
    const collaboratorQuery = query(
      collection(db, COLLABORATOR_COLLECTION),
      where("user_id", "==", currentUser.uid),
      where("status", "==", "accepted")
    );
    const collaboratorSnapshot = await getDocs(collaboratorQuery);

    collaboratorSnapshot.forEach(item => {
      activityCollaboratorDocs.push({
        document_id: item.id,
        ...item.data()
      });
    });
  } catch (error) {
    console.warn("Could not load activity collaborator records:", error);
  }

  for (const itinerary of accessibleItineraries) {
    try {
      const notificationQuery = query(
        collection(db, NOTIFICATION_COLLECTION),
        where("itinerary_id", "==", itinerary.itinerary_id)
      );
      const notificationSnapshot = await getDocs(notificationQuery);
      const collaborator = activityCollaboratorDocs.find(item => {
        return item.itinerary_id === itinerary.itinerary_id;
      });
      const lastViewedAt = collaborator
        ? timestampMillis(collaborator.last_activity_viewed_at)
        : Date.now();

      const activityItems = [];

      notificationSnapshot.forEach(item => {
        const notification = {
          document_id: item.id,
          itinerary_title: itinerary.title,
          last_viewed_at: lastViewedAt,
          ...item.data()
        };

        if (notification.actor_id !== currentUser.uid) {
          activityItems.push(notification);
        }
      });

      itinerary.activity_notifications = dedupeNotifications(activityItems)
        .sort((a, b) => timestampMillis(b.created_at) - timestampMillis(a.created_at))
        .slice(0, 10);
      itinerary.unread_activity_count = itinerary.activity_notifications.filter(item => {
        return timestampMillis(item.created_at) > Number(item.last_viewed_at || 0);
      }).length;
    } catch (error) {
      console.warn("Could not load activity notifications:", error);
      itinerary.activity_notifications = [];
      itinerary.unread_activity_count = 0;
    }
  }
}

async function loadSavedItineraries(user) {
  resetView();
  const results = await Promise.allSettled([
    loadOwnedItineraries(user),
    loadSharedItineraries(user),
    loadPendingRequests(user)
  ]);
  const [ownedItineraries, sharedItineraries, requests] = results.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    console.warn(["Owned", "Shared", "Request"][index] + " itinerary load failed:", result.reason);
    return [];
  });

  hideLoading();
  renderRequests(requests);
  await loadActivityNotifications(ownedItineraries, sharedItineraries);

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
    const unreadActivityCount = Number(itinerary.unread_activity_count || 0);
    const row = document.createElement("div");
    row.className = "saved-row";
    row.innerHTML = `
      <div class="saved-icon">🗓️</div>
      <div class="saved-info">
        <div class="saved-title">
          ${escapeHtml(itinerary.title)}
        </div>
        <div class="saved-meta">
          <span class="badge ${badgeClass} saved-status-badge">${escapeHtml(status)}</span>
          &nbsp;-&nbsp;
          ${escapeHtml(formatDate(itinerary.date))}
          &nbsp;-&nbsp; ${escapeHtml(formatDuration(itinerary.duration_minutes))}
          &nbsp;-&nbsp; ${escapeHtml(itinerary.stop_count)} stops
          &nbsp;-&nbsp; ${escapeHtml(itinerary.collaborator_count)} people
        </div>
      </div>
      <div class="saved-actions">
        <span class="row-activity-wrap">
          <button type="button" class="activity-bell-btn js-row-activity" aria-label="Activity for ${escapeHtml(itinerary.title)}">
            🔔
            <span class="activity-count-badge" style="${unreadActivityCount ? "display:inline-flex;" : ""}">${unreadActivityCount}</span>
          </button>
          <div class="activity-panel" aria-label="Recent activity for ${escapeHtml(itinerary.title)}">
            <div class="activity-panel-title">Recent Activity</div>
            ${activityPanelHtml(itinerary)}
          </div>
        </span>
        <a href="/saved-itineraries/${encodeURIComponent(itinerary.id)}" class="btn btn-secondary btn-sm">View</a>
        ${canEdit ? `<a href="/saved-itineraries/${encodeURIComponent(itinerary.id)}/edit" class="btn btn-secondary btn-sm">Edit</a>` : ""}
        <button type="button" class="btn btn-secondary btn-sm js-people-itinerary">People</button>
        ${listType === "owned" ? `<button type="button" class="btn btn-secondary btn-sm js-invite-itinerary">Invite</button>` : ""}
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

    row.querySelector(".js-invite-itinerary")?.addEventListener("click", function () {
      openInviteModal(itinerary);
    });

    row.querySelector(".js-people-itinerary")?.addEventListener("click", function () {
      openPeopleModal(itinerary);
    });

    row.querySelector(".js-row-activity")?.addEventListener("click", function (event) {
      event.stopPropagation();
      document.querySelectorAll(".row-activity-wrap .activity-panel.show").forEach(panel => {
        if (!row.contains(panel)) closeRowActivityPanel(panel);
      });
      const panel = row.querySelector(".row-activity-wrap .activity-panel");
      const shouldOpen = panel && !panel.classList.contains("show");

      if (panel && shouldOpen) {
        panel.classList.add("show");
        positionRowActivityPanel(event.currentTarget, panel);
        markItineraryActivityViewed(itinerary, row).catch(error => {
          console.error("Failed to mark itinerary activity viewed:", error);
        });
      } else if (panel) {
        closeRowActivityPanel(panel);
      }
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

function activityPanelHtml(itinerary) {
  const notifications = itinerary.activity_notifications || [];

  if (!notifications.length) {
    return `<div class="request-empty">No recent activity.</div>`;
  }

  return notifications.map(item => {
    const isUnread = timestampMillis(item.created_at) > Number(item.last_viewed_at || 0);
    return `
      <div class="activity-item">
        <div class="activity-title ${isUnread ? "is-unread" : ""}">
          ${escapeHtml(item.message || "Itinerary updated")}
        </div>
        <div class="request-meta">
          ${escapeHtml(item.itinerary_title || "Itinerary")} - ${escapeHtml(formatRelativeTime(item.created_at))}
        </div>
      </div>
    `;
  }).join("");
}

function positionRowActivityPanel(button, panel) {
  if (!button || !panel) return;

  panel.classList.add("is-floating");
  panel.style.visibility = "hidden";
  panel.style.left = "0px";
  panel.style.top = "0px";

  const buttonRect = button.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const padding = 12;
  const left = Math.min(
    Math.max(padding, buttonRect.right - panelRect.width),
    window.innerWidth - panelRect.width - padding
  );
  const preferredTop = buttonRect.bottom + 8;
  const top = preferredTop + panelRect.height + padding > window.innerHeight
    ? Math.max(padding, buttonRect.top - panelRect.height - 8)
    : preferredTop;

  panel.style.left = `${left}px`;
  panel.style.top = `${top}px`;
  panel.style.visibility = "";
}

function closeRowActivityPanel(panel) {
  panel.classList.remove("show", "is-floating");
  panel.style.left = "";
  panel.style.top = "";
  panel.style.visibility = "";
}

async function markItineraryActivityViewed(itinerary, row) {
  if (!currentUser || !itinerary) return;

  const collaborator = activityCollaboratorDocs.find(item => {
    return item.itinerary_id === itinerary.itinerary_id;
  });

  if (collaborator?.document_id) {
    await updateDoc(doc(db, COLLABORATOR_COLLECTION, collaborator.document_id), {
      last_activity_viewed_at: serverTimestamp()
    });
  }

  itinerary.activity_notifications = (itinerary.activity_notifications || []).map(item => ({
    ...item,
    last_viewed_at: Date.now()
  }));
  itinerary.unread_activity_count = 0;

  const badge = row?.querySelector(".activity-count-badge");
  if (badge) {
    badge.textContent = "0";
    badge.style.display = "none";
  }

  row?.querySelectorAll(".activity-title.is-unread").forEach(element => {
    element.classList.remove("is-unread");
  });
}

async function acceptRequest(request) {
  const itineraryDocumentId =
    request.itinerary_document_id ||
    request.itinerary.id;

  const acceptedId = collaboratorDocumentId(
    itineraryDocumentId,
    currentUser.uid
  );

  const acceptedData = {
    collaborator_id: acceptedId,
    itinerary_id: request.itinerary_id,
    itinerary_document_id: itineraryDocumentId,
    owner_id: request.owner_id,
    owner_email: request.owner_email || "",
    invited_by: request.invited_by,
    invited_by_name: request.invited_by_name || "",
    user_id: currentUser.uid,
    email: normaliseEmail(currentUser.email),
    display_name: currentUser.displayName || "",
    role: request.role || "viewer",
    status: "accepted",
    created_at:
      request.created_at ||
      serverTimestamp(),
    accepted_at: serverTimestamp(),
    updated_at: serverTimestamp()
  };

  if (request.id === acceptedId) {
    await updateDoc(
      doc(
        db,
        COLLABORATOR_COLLECTION,
        request.id
      ),
      acceptedData
    );
  } else {
    await setDoc(
      doc(
        db,
        COLLABORATOR_COLLECTION,
        acceptedId
      ),
      acceptedData
    );

    await deleteDoc(
      doc(
        db,
        COLLABORATOR_COLLECTION,
        request.id
      )
    );
  }

  const notificationRef =
    doc(collection(db, NOTIFICATION_COLLECTION));
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
    document.querySelectorAll(".row-activity-wrap .activity-panel.show").forEach(panel => {
      closeRowActivityPanel(panel);
    });
  });
  document.addEventListener("click", function (event) {
    if (!requestPanel.contains(event.target) && !requestButton.contains(event.target)) {
      requestPanel.classList.remove("show");
    }
  });
}

document.addEventListener("click", function (event) {
  if (!event.target.closest(".row-activity-wrap")) {
    document.querySelectorAll(".row-activity-wrap .activity-panel.show").forEach(panel => {
      closeRowActivityPanel(panel);
    });
  }
});


inviteForm?.addEventListener("submit", function (event) {
  event.preventDefault();
  const email = normaliseEmail(inviteEmailInput?.value);

  if (!isValidInviteEmail(email)) {
    setInviteMessage("Enter a valid email address.", true);
    return;
  }

  if (email === normaliseEmail(currentUser?.email)) {
    setInviteMessage("You are already the owner of this itinerary.", true);
    return;
  }

  setInviteMessage("");
  clearInviteSuggestions();

  const submitButton = inviteForm.querySelector('button[type="submit"]');
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "Inviting...";
  }

  inviteCollaboratorFromList(email)
    .catch(error => {
      console.error("Invite failed:", error);
      setInviteMessage("Could not send the invite.", true);
    })
    .finally(() => {
      if (submitButton) {
        submitButton.disabled = false;
        submitButton.textContent = "Invite";
      }
    });
});

inviteEmailInput?.addEventListener("input", function () {
  clearTimeout(inviteSearchTimer);
  const value = inviteEmailInput.value;
  inviteSearchTimer = setTimeout(function () {
    searchInviteUsers(value);
  }, 250);
});

inviteEmailInput?.addEventListener("focus", function () {
  if (inviteSuggestions?.innerHTML.trim()) {
    inviteSuggestions.classList.add("show");
  }
});

document.addEventListener("click", function (event) {
  if (!event.target.closest(".saved-invite-field")) {
    clearInviteSuggestions();
  }
});

sendInviteEmailButton?.addEventListener("click", function () {
  if (!pendingInviteLink || !pendingInviteEmail || !pendingInviteItinerary) return;
  const subject = encodeURIComponent(`Invitation: ${pendingInviteItinerary.title}`);
  const body = encodeURIComponent(
    `Hi,\n\n${currentUserDisplayName()} invited you to collaborate on a PandaJourney itinerary.\n\n` +
    `Itinerary: ${pendingInviteItinerary.title}\n` +
    `Travel date: ${formatDate(pendingInviteItinerary.date)}\n` +
    `Default access: Viewer\n\n` +
    `Open this link to join or create your account:\n${pendingInviteLink}\n\n` +
    `Thank you,\nPandaJourney`
  );
  window.open(
    `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(pendingInviteEmail)}&su=${subject}&body=${body}`,
    "_blank",
    "noopener,noreferrer"
  );
});

copyInviteLinkButton?.addEventListener("click", async function () {
  if (!pendingInviteLink) return;
  await navigator.clipboard.writeText(pendingInviteLink);
  setInviteMessage("Joining link copied.");
});

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
