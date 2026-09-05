import { auth, db } from "./firebase-config.js";
import { onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  onSnapshot,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  startAt,
  updateDoc,
  where,
  writeBatch,
  endAt
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

import {
  validateContent
} from "./content_filter.js";

const ITINERARY_COLLECTION = "Itinerary";
const STOP_COLLECTION = "itinerary_stops";
const COLLABORATOR_COLLECTION = "collaborators";
const COMMENT_COLLECTION = "comments";
const NOTIFICATION_COLLECTION = "notifications";
const USER_COLLECTION = "users";
const MAX_EDIT_STOPS = 10;
const MAX_TRAVEL_LEG_MINUTES = 240;

const pageElement = document.getElementById("edit-page");
const loadingElement = document.getElementById("edit-loading");
const errorElement = document.getElementById("edit-error");
const contentElement = document.getElementById("edit-content");
const titleInput = document.getElementById("itinerary-title-input");
const dateInput = document.getElementById("itinerary-date-input");
const daysInput = document.getElementById("itinerary-days-input");
const dateRangeText = document.getElementById("itinerary-date-range");
const dayStartGrid = document.getElementById("day-start-grid");
const routeStartInput = document.getElementById("route-start-input");
const routeEndInput = document.getElementById("route-end-input");
const routeStartSuggestions = document.getElementById("route-start-suggestions");
const routeEndSuggestions = document.getElementById("route-end-suggestions");
const routeHoursInput = document.getElementById("route-hours-input");
const routeHoursUnlimitedInput = document.getElementById("route-hours-unlimited-input");
const routeInterestInput = document.getElementById("route-interest-input");
const saveRouteDetailsButton = document.getElementById("save-route-details-btn");
const routeSaveMessage = document.getElementById("route-save-message");
const stopCountText = document.getElementById("itinerary-stop-count");
const hoursText = document.getElementById("itinerary-hours-text");
const roleBadge = document.getElementById("editor-role-badge");
const peopleCount = document.getElementById("people-count");
const stopList = document.getElementById("stop-list");
const addStopButton = document.getElementById("add-stop-btn");
const collaboratorList = document.getElementById("collaborator-list");
const inviteForm = document.getElementById("invite-form");
const inviteEmailInput = document.getElementById("invite-email-input");
const inviteMessage = document.getElementById("invite-message");
const inviteOptions = document.getElementById("invite-options");
const inviteSuggestions = document.getElementById("invite-suggestions");
const sendJoinEmailButton = document.getElementById("send-join-email-btn");
const copyJoinLinkButton = document.getElementById("copy-join-link-btn");
const commentsList = document.getElementById("comments-list");
const commentForm = document.getElementById("comment-form");
const commentInput = document.getElementById("comment-input");
const commentMessage = document.getElementById("comment-message");
const activityList = document.getElementById("activity-list");
const viewAllActivityButton = document.getElementById("view-all-activity-btn");
const confirmModal = document.getElementById("edit-confirm-modal");
const confirmTitle = document.getElementById("edit-confirm-title");
const confirmMessage = document.getElementById("edit-confirm-message");
const confirmCancelButton = document.getElementById("edit-confirm-cancel");
const confirmDeleteButton = document.getElementById("edit-confirm-delete");

const itineraryDocumentId = pageElement?.dataset.itineraryId || "";

let currentUser = null;
let itinerary = null;
let editMap = null;
let activeItineraryId = itineraryDocumentId;
let collaboratorDocs = [];
let stopDocs = [];
let currentRole = "viewer";
let canEdit = false;
let isOwner = false;
let allActivityMode = false;
let tripDetailsDirty = false;
let lastActivityViewedAt = 0;
let lastCommentsViewedAt = 0;
let ownCollaboratorDocumentId = "";
let hasCommentsViewedState = false;
let pendingInviteLink = "";
let pendingInviteEmail = "";
let inviteSearchTimer = null;
let unsubscribeFns = [];
let draggedStopId = "";
let editingStopId = "";
let editingCommentId = "";
let pendingConfirmAction = null;
let draftStop = null;
let selectedStopPlaces = {};
let stopSuggestionTimers = {};
let selectedRoutePlaces = {};
let routeSuggestionTimers = {};
let busyAction = "";
let selectedTripPhotoStopId = "";
let routeMapRenderTimer = null;
let latestRouteMapKey = "";
let activeRouteMapRequest = 0;
let latestTripPhotoKey = "";
let commentsSeenTimer = null;
let highlightRefreshTimer = null;
let latestCommentDocs = [];
let latestActivityDocs = [];
const NEW_HIGHLIGHT_MS = 60 * 1000;
const temporaryActivityHighlights = new Map();
const temporaryCommentHighlights = new Map();
const userProfileCache = new Map();
const placePhotoCache = new Map();
const placePhotoHtmlCache = new Map();

function normaliseRatingForSave(value) {
  if (value === "Not available") return "Not available";
  const numberValue = Number(value || 0);
  return Number.isFinite(numberValue) && numberValue > 0
    ? numberValue
    : "Not available";
}

function isGenericLocationName(value) {
  const name = String(value || "").trim().toLowerCase();
  return [
    "kuala lumpur, malaysia",
    "federal territory of kuala lumpur, malaysia",
    "malaysia"
  ].includes(name);
}

function isCurrentLocationName(value) {
  return String(value || "").trim().toLowerCase() === "current location";
}

function getStopPlaceName(stop) {
  return String(stop?.stop_name || stop?.place || "").trim();
}

function getPhotoStops(stops) {
  return (stops || []).filter(stop => {
    const placeName = getStopPlaceName(stop);
    return placeName && !isGenericLocationName(placeName);
  });
}

function getRouteMarkerRows(calculatedStops = []) {
  const startName = String(itinerary?.start_location_name || "").trim();
  const endName = String(itinerary?.end_location_name || itinerary?.destination || "").trim();
  const dayStartTimes = getDayStartTimes();
  const startTime = formatClockMinutes(parseClockMinutes(dayStartTimes["1"] || itinerary?.start_time || "09:00"));
  const lastStop = calculatedStops.length ? calculatedStops[calculatedStops.length - 1] : null;
  const finalTravelMinutes = getStoredFinalTravelMinutes(calculatedStops);
  const lastStopEndMinutes = lastStop
    ? parseClockMinutes(lastStop.departure_time || lastStop.arrival_time || "")
    : 0;
  const endTime = lastStop && finalTravelMinutes
    ? formatClockMinutes(lastStopEndMinutes + finalTravelMinutes)
    : lastStop?.departure_time || lastStop?.arrival_time || "";
  const rows = [];

  if (startName) {
    rows.push({
      document_id: "__route_start__",
      stop_name: startName,
      routeMarkerType: "Start",
      routeMarkerSubtitle: `Starting location - Start time: ${startTime}`
    });
  }

  if (endName) {
    rows.push({
      document_id: "__route_end__",
      stop_name: endName,
      routeMarkerType: "End",
      routeMarkerSubtitle: endTime
        ? `Ending location - End time: ${endTime}`
        : "Ending location"
    });
  }

  return rows;
}

function getTripPhotoCandidates() {
  const routeMarkers = getRouteMarkerRows();
  return [
    ...(routeMarkers[0] ? [routeMarkers[0]] : []),
    ...stopDocs,
    ...(routeMarkers[1] ? [routeMarkers[1]] : [])
  ];
}

async function getPlacePhoto(placeName) {
  if (placePhotoCache.has(placeName)) {
    return await placePhotoCache.get(placeName);
  }

  const photoPromise = (async function () {
    try {
    const response = await fetch(
      `/api/public-place-photo?name=${encodeURIComponent(placeName)}`
    );
    const data = await response.json();
    return {
      imageUrl: data.image_url || "",
      placeName
    };
  } catch (error) {
    console.error("Edit photo failed:", error);
    return {
      imageUrl: "",
      placeName
    };
  }
  })();

  placePhotoCache.set(placeName, photoPromise);
  return await photoPromise;
}

function showError() {
  if (loadingElement) loadingElement.style.display = "none";
  if (contentElement) contentElement.style.display = "none";
  if (errorElement) errorElement.style.display = "block";
}

function showContent() {
  if (loadingElement) loadingElement.style.display = "none";
  if (errorElement) errorElement.style.display = "none";
  if (contentElement) contentElement.style.display = "grid";
}

function openConfirmModal(title, message, onConfirm) {
  pendingConfirmAction = onConfirm;
  if (confirmTitle) confirmTitle.textContent = title || "Confirm action";
  if (confirmMessage) confirmMessage.textContent = message || "This action cannot be undone.";
  if (confirmDeleteButton) confirmDeleteButton.style.display = typeof onConfirm === "function" ? "inline-flex" : "none";
  if (confirmCancelButton) confirmCancelButton.textContent = typeof onConfirm === "function" ? "Cancel" : "OK";
  if (!confirmModal) return;
  confirmModal.classList.add("show");
  confirmModal.setAttribute("aria-hidden", "false");
  if (typeof onConfirm === "function") {
    confirmDeleteButton?.focus();
  } else {
    confirmCancelButton?.focus();
  }
}

function closeConfirmModal() {
  pendingConfirmAction = null;
  if (confirmDeleteButton) confirmDeleteButton.style.display = "";
  if (confirmCancelButton) confirmCancelButton.textContent = "Cancel";
  if (!confirmModal) return;
  confirmModal.classList.remove("show");
  confirmModal.setAttribute("aria-hidden", "true");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
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

function expectedCollaboratorDocumentId(collaborator) {
  if (!itinerary?.document_id) return "";
  if (collaborator.user_id) {
    return collaboratorDocumentId(itinerary.document_id, collaborator.user_id);
  }
  if (collaborator.email) {
    return pendingInviteDocumentId(itinerary.document_id, collaborator.email);
  }
  return "";
}

function collaboratorKey(collaborator) {
  return collaborator.user_id || normaliseEmail(collaborator.email) || collaborator.document_id || "";
}

function collaboratorRank(collaborator) {
  const roleRanks = { owner: 30, editor: 20, viewer: 10 };
  const statusRanks = { accepted: 3, pending: 2, pending_registration: 1, declined: 0 };
  const role = String(collaborator.role || "viewer").toLowerCase();
  const status = String(collaborator.status || "accepted").toLowerCase();
  const canonicalBonus = collaborator.document_id === expectedCollaboratorDocumentId(collaborator) ? 100 : 0;
  return canonicalBonus + (roleRanks[role] || 0) + (statusRanks[status] || 0);
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

function displayNameFromCollaborator(collaborator) {
  const profile = getCachedUserProfile(collaborator.user_id);
  if (profile?.displayName) return profile.displayName;
  const savedName = String(collaborator.display_name || "").trim();
  const email = String(collaborator.email || "").trim();
  if (savedName && savedName !== email) return savedName;
  const localPart = email.split("@")[0] || "Collaborator";
  return localPart
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, letter => letter.toUpperCase()) || "Collaborator";
}

function getCachedUserProfile(userId) {
  return userId ? userProfileCache.get(userId) || null : null;
}

function displayNameFromUserSnapshot(snapshot, fallbackName, fallbackEmail = "") {
  const profile = getCachedUserProfile(snapshot?.user_id || snapshot?.author_id || snapshot?.actor_id);
  const profileName = String(profile?.displayName || "").trim();
  if (profileName) return profileName;

  const savedName = String(fallbackName || "").trim();
  const email = String(fallbackEmail || "").trim();
  if (savedName && savedName !== email) return savedName;

  const localPart = email.split("@")[0] || "Collaborator";
  return localPart
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, letter => letter.toUpperCase()) || "Collaborator";
}

function avatarHtmlForUser(userId, fallbackName, className) {
  const profile = getCachedUserProfile(userId);
  const displayName = String(profile?.displayName || fallbackName || "Collaborator").trim();
  const avatarType = String(profile?.avatarType || "").trim();
  const avatarEmoji = String(profile?.avatar || "").trim();
  const uploadedAvatarUrl = String(profile?.avatarUrl || "").trim();
  const googleAvatarUrl = profile?.authProvider === "google"
    ? String(profile?.profilePictureUrl || "").trim()
    : "";
  const fallbackInitials = escapeHtml(initials(profile?.email || displayName));

  if (avatarType === "emoji" && avatarEmoji) {
    return `<div class="${className}">${escapeHtml(avatarEmoji)}</div>`;
  }

  if (avatarType === "upload" && uploadedAvatarUrl) {
    return `
      <div class="${className}">
        <img src="${escapeHtml(uploadedAvatarUrl)}" alt="" onerror="this.remove();">
      </div>
    `;
  }

  if (googleAvatarUrl) {
    return `
      <div class="${className}">
        <img src="${escapeHtml(googleAvatarUrl)}" alt="" onerror="this.remove();">
      </div>
    `;
  }

  return `<div class="${className}"><span>${fallbackInitials}</span></div>`;
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
    return email && user.id !== currentUser?.uid &&
      !collaboratorDocs.some(collaborator => normaliseEmail(collaborator.email) === email);
  });

  if (!eligibleUsers.length) {
    clearInviteSuggestions();
    return;
  }

  inviteSuggestions.innerHTML = "";
  eligibleUsers.forEach(user => {
    userProfileCache.set(user.id, user);
    const name = String(user.displayName || user.email || "PandaJourney user").trim();
    const option = document.createElement("button");
    option.type = "button";
    option.className = "invite-suggestion";
    option.innerHTML = `
      ${avatarHtmlForUser(user.id, name, "invite-suggestion-avatar")}
      <span class="invite-suggestion-details">
        <span class="invite-suggestion-name">${escapeHtml(name)}</span>
        <span class="invite-suggestion-email">${escapeHtml(user.email || "")}</span>
      </span>
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

async function searchRegisteredUsers(searchTerm) {
  const prefix = normaliseEmail(searchTerm);
  if (!isOwner || prefix.length < 2) {
    clearInviteSuggestions();
    return;
  }

  try {
    const usersQuery = query(
      collection(db, USER_COLLECTION),
      orderBy("email"),
      startAt(prefix),
      endAt(`${prefix}\uf8ff`),
      limit(6)
    );
    const snapshot = await getDocs(usersQuery);
    if (prefix !== normaliseEmail(inviteEmailInput?.value)) return;
    renderInviteSuggestions(snapshot.docs.map(item => ({ id: item.id, ...item.data() })));
  } catch (error) {
    console.error("User search failed:", error);
    clearInviteSuggestions();
  }
}

async function loadUserProfilesForIds(userIds) {
  const uniqueIds = [...new Set(userIds.filter(Boolean))];
  const missingIds = uniqueIds.filter(userId => !userProfileCache.has(userId));

  await Promise.all(missingIds.map(async userId => {
    try {
      const snapshot = await getDoc(doc(db, USER_COLLECTION, userId));
      userProfileCache.set(userId, snapshot.exists() ? snapshot.data() : null);
    } catch (error) {
      console.error("Failed to load user profile:", error);
      userProfileCache.set(userId, null);
    }
  }));
}

function currentUserDisplayName() {
  const profileName = String(getCachedUserProfile(currentUser?.uid)?.displayName || "").trim();
  return profileName || currentUser?.displayName || currentUser?.email || "A collaborator";
}

function applyCurrentProfileToMessage(activity) {
  const name = displayNameFromUserSnapshot(activity, activity.actor_name, "");
  const message = String(activity.message || "Itinerary updated");
  const oldName = String(activity.actor_name || "").trim();

  if (oldName && name && message.startsWith(oldName)) {
    return `${name}${message.slice(oldName.length)}`;
  }

  return message;
}

function timestampMillis(value) {
  if (!value) return 0;
  if (value.toMillis) return value.toMillis();
  if (value.toDate) return value.toDate().getTime();
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

function formatDate(value) {
  if (!value) return "No date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-MY", { year: "numeric", month: "short", day: "2-digit" });
}

function getTripDays() {
  const rawValue = daysInput?.value || itinerary?.trip_days || itinerary?.day_count || 1;
  const days = Math.round(Number(rawValue || 1));
  return Math.min(30, Math.max(1, Number.isFinite(days) ? days : 1));
}

function normaliseDayNumber(value) {
  const dayNumber = Math.round(Number(value || 1));
  return Math.min(getTripDays(), Math.max(1, Number.isFinite(dayNumber) ? dayNumber : 1));
}

function addDaysToDate(dateText, daysToAdd) {
  if (!dateText) return "";
  const date = new Date(`${dateText}T00:00:00`);
  if (Number.isNaN(date.getTime())) return "";
  date.setDate(date.getDate() + daysToAdd);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatTripDateRange() {
  const days = getTripDays();
  const startDate = dateInput?.value || itinerary?.travel_date || "";
  const endDate = addDaysToDate(startDate, days - 1);

  if (days <= 1) return "1 day";
  if (!startDate || !endDate) return `${days} days`;
  return `${formatDate(startDate)} - ${formatDate(endDate)} (${days} days)`;
}

function getDayStartTimes() {
  const savedTimes = itinerary?.day_start_times && typeof itinerary.day_start_times === "object"
    ? itinerary.day_start_times
    : {};
  const fallbackTime = itinerary?.start_time || "09:00";
  const result = {};

  for (let dayNumber = 1; dayNumber <= getTripDays(); dayNumber += 1) {
    result[String(dayNumber)] = savedTimes[String(dayNumber)] || fallbackTime;
  }

  return result;
}

function getDayStartTime(dayNumber) {
  const safeDayNumber = normaliseDayNumber(dayNumber);
  const input = dayStartGrid?.querySelector(`.js-day-start-time[data-day-number="${safeDayNumber}"]`);
  return input?.value || getDayStartTimes()[String(safeDayNumber)] || itinerary?.start_time || "09:00";
}

function getDayStartTimesFromInputs(days = getTripDays()) {
  const savedTimes = getDayStartTimes();
  const result = {};

  for (let dayNumber = 1; dayNumber <= days; dayNumber += 1) {
    const input = dayStartGrid?.querySelector(`.js-day-start-time[data-day-number="${dayNumber}"]`);
    result[String(dayNumber)] = input?.value || savedTimes[String(dayNumber)] || itinerary?.start_time || "09:00";
  }

  return result;
}

function renderDayStartControls(dayStartTimesOverride = null) {
  if (!dayStartGrid) return;

  const dayStartTimes = dayStartTimesOverride || getDayStartTimes();
  dayStartGrid.innerHTML = Array.from({ length: getTripDays() }, (_, index) => {
    const dayNumber = index + 1;
    return `
      <label class="day-start-control">
        Day ${dayNumber} starts
        <input
          type="time"
          class="js-day-start-time"
          data-day-number="${dayNumber}"
          value="${escapeHtml(dayStartTimes[String(dayNumber)] || "09:00")}"
          ${canEdit ? "" : "disabled"}
          aria-label="Day ${dayNumber} start time"
        >
      </label>
    `;
  }).join("");
}

function formatMinutesAsDuration(minutes) {
  const totalMinutes = Number(minutes || 0);
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return "Estimated";

  const hours = Math.floor(totalMinutes / 60);
  const remainder = totalMinutes % 60;

  if (!hours) return `${remainder} mins`;
  if (!remainder) return `${hours} hr${hours === 1 ? "" : "s"}`;
  return `${hours} hr${hours === 1 ? "" : "s"} ${remainder} mins`;
}

function extractMinutesFromText(text) {
  const value = String(text || "").toLowerCase();
  const hourMatch = value.match(/(\d+)\s*h/);
  const minuteMatch = value.match(/(\d+)\s*m/);
  let totalMinutes = 0;

  if (hourMatch) {
    totalMinutes += Number(hourMatch[1]) * 60;
  }

  if (minuteMatch) {
    totalMinutes += Number(minuteMatch[1]);
  }

  if (totalMinutes > 0) {
    return totalMinutes;
  }

  const fallbackMatch = value.match(/\d+/);
  return fallbackMatch ? Number(fallbackMatch[0]) : 0;
}

function isRouteTimeUnlimited() {
  return Boolean(
    routeHoursUnlimitedInput?.checked ||
    itinerary?.available_hours_unlimited ||
    String(itinerary?.available_hours || "").toLowerCase() === "unlimited"
  );
}

function getAvailableRouteMinutes() {
  if (isRouteTimeUnlimited()) return Infinity;
  const hours = Number(routeHoursInput?.value || itinerary?.available_hours || 0);
  return Number.isFinite(hours) && hours > 0 ? hours * 60 * getTripDays() : 0;
}

function getRouteOverageMessage(totalMinutes) {
  const availableMinutes = getAvailableRouteMinutes();
  if (!Number.isFinite(availableMinutes) || !availableMinutes) return "";
  const overBy = Math.max(0, Math.ceil(Number(totalMinutes || 0) - availableMinutes));
  if (!overBy) return "";
  return `This itinerary is ${formatMinutesAsDuration(overBy)} over the available time across ${getTripDays()} day${getTripDays() === 1 ? "" : "s"}. Increase available hours, add more days, or choose No time limit before adding more stops.`;
}

function routeExceedsAvailableTime(totalMinutes) {
  return Boolean(getRouteOverageMessage(totalMinutes));
}

function normaliseInterest(value) {
  return String(value || "").trim().toLowerCase();
}

function getSavedInterests() {
  const saved = Array.isArray(itinerary?.interests)
    ? itinerary.interests
    : [itinerary?.interest];

  const interests = saved
    .map(normaliseInterest)
    .filter(Boolean);

  return interests.length ? [...new Set(interests)] : ["culture"];
}

function getSelectedRouteInterests() {
  const checked = Array.from(document.querySelectorAll('input[name="route_interests"]:checked'))
    .map(input => normaliseInterest(input.value))
    .filter(Boolean);

  return checked.length ? checked : [];
}

function formatInterests(interests) {
  const values = (Array.isArray(interests) ? interests : [interests])
    .map(normaliseInterest)
    .filter(Boolean);

  if (!values.length) return "Culture";

  return [...new Set(values)]
    .map(value => value.charAt(0).toUpperCase() + value.slice(1))
    .join(", ");
}

function showStopSuggestionStatus(boxElement, message) {
  if (!boxElement) return;
  boxElement.hidden = false;
  boxElement.innerHTML = `<div class="stop-suggestion-item"><span class="stop-suggestion-sub">${escapeHtml(message)}</span></div>`;
}

function hideStopSuggestions(boxElement) {
  if (!boxElement) return;
  boxElement.hidden = true;
  boxElement.innerHTML = "";
}

function renderStopSuggestions(inputElement, boxElement, stopId, payload) {
  if (!inputElement || !boxElement) return;
  const customLocation = payload?.custom_location || null;
  const suggestions = Array.isArray(payload?.suggestions)
    ? payload.suggestions
    : Array.isArray(payload)
      ? payload
      : [];

  if (!customLocation && !suggestions.length) {
    showStopSuggestionStatus(boxElement, "No location found.");
    return;
  }

  boxElement.hidden = false;
  boxElement.innerHTML = "";

  if (customLocation) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "stop-suggestion-item stop-suggestion-custom";
    button.innerHTML = `
      <span class="stop-suggestion-kicker">Use searched location</span>
      <span class="stop-suggestion-name">${escapeHtml(customLocation.display_name)}</span>
      <span class="stop-suggestion-meta">
        <span>Category: Custom Stop</span>
        <span>Rating: Not available</span>
      </span>
      <span class="stop-suggestion-sub">${escapeHtml(customLocation.address || customLocation.source || "")}</span>
    `;
    button.addEventListener("click", function () {
      inputElement.value = customLocation.display_name;
      selectedStopPlaces[stopId] = customLocation;
      hideStopSuggestions(boxElement);
    });
    boxElement.appendChild(button);
  }

  suggestions.forEach(suggestion => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "stop-suggestion-item";
    const ratingText = suggestion.rating && suggestion.rating !== "Not available"
      ? `${suggestion.rating}`
      : "Not available";
    button.innerHTML = `
      <span class="stop-suggestion-kicker">Suggested attraction</span>
      <span class="stop-suggestion-name">${escapeHtml(suggestion.display_name || suggestion.name)}</span>
      <span class="stop-suggestion-meta">
        <span>Category: ${escapeHtml(suggestion.category || "Attraction")}</span>
        <span>Rating: ${escapeHtml(ratingText)}</span>
      </span>
      <span class="stop-suggestion-sub">${escapeHtml(suggestion.address || suggestion.source || "")}</span>
    `;
      button.addEventListener("click", function () {
        inputElement.value = suggestion.display_name || suggestion.name || "";
        selectedStopPlaces[stopId] = suggestion;
        const warningElement = boxElement.closest(".stop-edit-panel")?.querySelector(".js-stop-warning");
        clearStopValidationError(warningElement);
        hideStopSuggestions(boxElement);
      });
    boxElement.appendChild(button);
  });
}

function setupStopPlaceAutocomplete(row, stopId, stop) {
  const inputElement = row.querySelector(".js-stop-name");
  const boxElement = row.querySelector(".js-stop-suggestions");
  if (!inputElement || !boxElement) return;

  inputElement.addEventListener("input", function () {
    selectedStopPlaces[stopId] = null;
    const warningElement = row.querySelector(".js-stop-warning");
    clearStopValidationError(warningElement);
    const queryText = inputElement.value.trim();
    clearTimeout(stopSuggestionTimers[stopId]);

    if (queryText.length < 3) {
      hideStopSuggestions(boxElement);
      return;
    }

    showStopSuggestionStatus(boxElement, "Searching locations...");
    stopSuggestionTimers[stopId] = setTimeout(function () {
      const interests = getSelectedRouteInterests().length
        ? getSelectedRouteInterests()
        : getSavedInterests();
      const params = new URLSearchParams({
        q: queryText,
        interests: interests.join(",")
      });
      fetch(`/api/edit-stop-suggestions?${params.toString()}`)
        .then(response => {
          if (!response.ok) throw new Error("Stop suggestion request failed.");
          return response.json();
        })
        .then(data => {
          if (queryText !== inputElement.value.trim()) return;
          renderStopSuggestions(inputElement, boxElement, stopId, data);
        })
        .catch(error => {
          console.error("Stop suggestion error:", error);
          showStopSuggestionStatus(boxElement, "Unable to load suggestions.");
        });
    }, 500);
  });

  inputElement.addEventListener("focus", function () {
    if (boxElement.innerHTML.trim()) boxElement.hidden = false;
  });
}

function renderRouteSuggestions(inputElement, boxElement, fieldName, suggestions) {
  if (!inputElement || !boxElement) return;
  if (!suggestions.length) {
    showSuggestionStatus(boxElement, "No location found.", "route-suggestion-item", "route-suggestion-sub");
    return;
  }

  boxElement.hidden = false;
  boxElement.innerHTML = "";
  suggestions.forEach(suggestion => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "route-suggestion-item";
    button.innerHTML = `
      <span class="route-suggestion-name">${escapeHtml(suggestion.display_name)}</span>
      <span class="route-suggestion-sub">${escapeHtml(suggestion.source || "Location suggestion")}</span>
    `;
    button.addEventListener("click", function () {
      inputElement.value = suggestion.display_name;
      selectedRoutePlaces[fieldName] = suggestion;
      markTripDetailsDirty();
      hideSuggestions(boxElement);
    });
    boxElement.appendChild(button);
  });
}

function setupRoutePlaceAutocomplete(inputElement, boxElement, fieldName) {
  if (!inputElement || !boxElement) return;

  inputElement.addEventListener("input", function () {
    selectedRoutePlaces[fieldName] = null;
    const queryText = inputElement.value.trim();
    clearTimeout(routeSuggestionTimers[fieldName]);

    if (queryText.length < 3) {
      hideSuggestions(boxElement);
      return;
    }

    showSuggestionStatus(boxElement, "Searching locations...", "route-suggestion-item", "route-suggestion-sub");
    routeSuggestionTimers[fieldName] = setTimeout(function () {
      fetch(`/api/location-suggestions?q=${encodeURIComponent(queryText)}`)
        .then(response => {
          if (!response.ok) throw new Error("Location suggestion request failed.");
          return response.json();
        })
        .then(data => {
          if (queryText !== inputElement.value.trim()) return;
          renderRouteSuggestions(inputElement, boxElement, fieldName, data.suggestions || []);
        })
        .catch(error => {
          console.error("Route suggestion error:", error);
          showSuggestionStatus(boxElement, "Unable to load suggestions.", "route-suggestion-item", "route-suggestion-sub");
        });
    }, 500);
  });

  inputElement.addEventListener("focus", function () {
    if (boxElement.innerHTML.trim()) boxElement.hidden = false;
  });
}

function getSelectedStopPlaceChanges(stopId) {
  const place = selectedStopPlaces[stopId];
  if (!place) return {};
  return {
    place_id: place.place_id || "",
    stop_name: place.display_name || place.name || "",
    address: place.address || place.display_name || "",
    category: place.category || place.type || "Custom Stop",
    rating: normaliseRatingForSave(place.rating),
    latitude: Number(place.latitude),
    longitude: Number(place.longitude)
  };
}

function rememberTemporaryHighlight(store, id) {
  if (!id || store.has(id)) return;
  store.set(id, Date.now() + NEW_HIGHLIGHT_MS);
  scheduleHighlightRefresh();
}

function hasTemporaryHighlight(store, id) {
  const expiresAt = store.get(id);
  if (!expiresAt) return false;
  if (Date.now() > expiresAt) {
    store.delete(id);
    return false;
  }
  return true;
}

function scheduleHighlightRefresh() {
  clearTimeout(highlightRefreshTimer);
  highlightRefreshTimer = setTimeout(function () {
    renderComments(sortByCreatedDesc(latestCommentDocs).slice(0, 20));
    renderActivities(allActivityMode ? latestActivityDocs : latestActivityDocs.slice(0, 5));
  }, NEW_HIGHLIGHT_MS + 100);
}

function hasValidStopCoordinates(stop) {
  return hasCoordinateValue(stop.latitude) && hasCoordinateValue(stop.longitude);
}

function hasCoordinateValue(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function parseClockMinutes(value) {
  const text = String(value || "").trim();
  if (!text) return 9 * 60;

  const amPmMatch = text.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (amPmMatch) {
    let hour = Number(amPmMatch[1]);
    const minute = Number(amPmMatch[2]);
    const period = amPmMatch[3].toUpperCase();
    if (period === "PM" && hour !== 12) hour += 12;
    if (period === "AM" && hour === 12) hour = 0;
    return hour * 60 + minute;
  }

  const twentyFourHourMatch = text.match(/^(\d{1,2}):(\d{2})$/);
  if (twentyFourHourMatch) {
    return Number(twentyFourHourMatch[1]) * 60 + Number(twentyFourHourMatch[2]);
  }

  return 9 * 60;
}

function formatClockMinutes(value) {
  const total = ((Math.round(Number(value || 0)) % 1440) + 1440) % 1440;
  const hour24 = Math.floor(total / 60);
  const minute = total % 60;
  const period = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 || 12;
  return `${hour12}:${String(minute).padStart(2, "0")} ${period}`;
}

function distanceKm(pointA, pointB) {
  if (!hasValidStopCoordinates(pointA) || !hasValidStopCoordinates(pointB)) return 0;
  const lat1 = Number(pointA.latitude) * Math.PI / 180;
  const lat2 = Number(pointB.latitude) * Math.PI / 180;
  const deltaLat = (Number(pointB.latitude) - Number(pointA.latitude)) * Math.PI / 180;
  const deltaLng = (Number(pointB.longitude) - Number(pointA.longitude)) * Math.PI / 180;
  const a = Math.sin(deltaLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function estimateTravelMinutes(previousPoint, stop) {
  const km = distanceKm(previousPoint, stop);
  if (!km) return Number(stop.travel_minutes_from_previous || 0);
  return Math.max(5, Math.round((km / 35) * 60));
}

function recalculateStopTimes(stops) {
  let currentDay = 1;
  let cursor = parseClockMinutes(getDayStartTime(1));
  let previousPoint = {
    latitude: itinerary?.start_latitude,
    longitude: itinerary?.start_longitude
  };

  return stops.map((stop, index) => {
    const dayNumber = normaliseDayNumber(stop.day_number || stop.day || 1);
    if (index === 0 || dayNumber !== currentDay) {
      currentDay = dayNumber;
      cursor = parseClockMinutes(getDayStartTime(dayNumber));
    }

    const visitMinutes = Math.max(0, Number(stop.visit_duration_minutes || 0));
    const travelMinutes = estimateTravelMinutes(previousPoint, stop);
    const arrivalMinutes = cursor + travelMinutes;
    const departureMinutes = arrivalMinutes + visitMinutes;
    previousPoint = stop;
    cursor = departureMinutes;

    return {
      ...stop,
      day_number: dayNumber,
      stop_order: index + 1,
      travel_minutes_from_previous: travelMinutes,
      arrival_time: formatClockMinutes(arrivalMinutes),
      departure_time: formatClockMinutes(departureMinutes),
      visit_duration_minutes: visitMinutes
    };
  });
}

function recalculateStopTimesWithExistingTravel(stops) {
  let currentDay = 1;
  let cursor = parseClockMinutes(getDayStartTime(1));

  return stops.map((stop, index) => {
    const dayNumber = normaliseDayNumber(stop.day_number || stop.day || 1);
    if (index === 0 || dayNumber !== currentDay) {
      currentDay = dayNumber;
      cursor = parseClockMinutes(getDayStartTime(dayNumber));
    }

    const visitMinutes = Math.max(0, Number(stop.visit_duration_minutes || 0));
    const travelMinutes = Math.max(0, Number(stop.travel_minutes_from_previous || 0));
    const arrivalMinutes = cursor + travelMinutes;
    const departureMinutes = arrivalMinutes + visitMinutes;
    cursor = departureMinutes;

    return {
      ...stop,
      day_number: dayNumber,
      stop_order: index + 1,
      arrival_time: formatClockMinutes(arrivalMinutes),
      departure_time: formatClockMinutes(departureMinutes),
      visit_duration_minutes: visitMinutes,
      travel_minutes_from_previous: travelMinutes
    };
  });
}

function getItineraryPoint(prefix) {
  const rawLatitude = itinerary?.[`${prefix}_latitude`];
  const rawLongitude = itinerary?.[`${prefix}_longitude`];

  if (!hasCoordinateValue(rawLatitude) || !hasCoordinateValue(rawLongitude)) {
    return null;
  }

  return {
    latitude: Number(rawLatitude),
    longitude: Number(rawLongitude)
  };
}

function getPointFromStop(stop) {
  if (!hasValidStopCoordinates(stop)) {
    return null;
  }

  return {
    latitude: Number(stop.latitude),
    longitude: Number(stop.longitude)
  };
}

function getRouteSegmentLabel(fromMarker, toMarker) {
  return `Google Maps ${fromMarker} -> ${toMarker}`;
}

function buildCoordinateText(point) {
  if (!point) return "";

  const latitude = Number(point.latitude);
  const longitude = Number(point.longitude);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return "";
  }

  return `${latitude.toFixed(7)},${longitude.toFixed(7)}`;
}

function buildGoogleMapsUrl(originPoint, destinationPoint, useLiveCurrentLocation = false) {
  const destinationText = buildCoordinateText(destinationPoint);

  if (!destinationText) {
    return "";
  }

  const params = new URLSearchParams();
  params.set("api", "1");

  if (!useLiveCurrentLocation && originPoint) {
    const originText = buildCoordinateText(originPoint);

    if (originText) {
      params.set("origin", originText);
    }
  }

  params.set("destination", destinationText);
  params.set("travelmode", "driving");

  if (useLiveCurrentLocation) {
    params.set("dir_action", "navigate");
  }

  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function buildGoogleMapsRouteUrl(originPoint, destinationPoint, waypointPoints = [], useLiveCurrentLocation = false) {
  const destinationText = buildCoordinateText(destinationPoint);

  if (!destinationText) {
    return "";
  }

  const params = new URLSearchParams();
  params.set("api", "1");

  if (!useLiveCurrentLocation) {
    const originText = buildCoordinateText(originPoint);

    if (!originText) {
      return "";
    }

    params.set("origin", originText);
  }

  params.set("destination", destinationText);
  params.set("travelmode", "driving");

  const waypointTexts = waypointPoints
    .map(buildCoordinateText)
    .filter(Boolean);

  if (waypointTexts.length) {
    params.set("waypoints", waypointTexts.join("|"));
  }

  if (useLiveCurrentLocation) {
    params.set("dir_action", "navigate");
  }

  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function getDayRouteGoogleMaps(dayNumber, stops = stopDocs) {
  const numberedStops = stops.map((stop, index) => ({
    stop,
    marker: String(index + 1),
    dayNumber: normaliseDayNumber(stop.day_number || stop.day || 1),
    point: getPointFromStop(stop)
  }));
  const dayStops = numberedStops.filter(item => {
    return item.dayNumber === dayNumber && item.point;
  });

  if (!dayStops.length) return null;

  const previousStop = [...numberedStops].reverse().find(item => {
    return item.dayNumber < dayNumber && item.point;
  });
  const startPoint = getItineraryPoint("start");
  const endPoint = getItineraryPoint("end");
  const isFirstDay = dayNumber === 1;
  const isFinalDay = dayNumber === getTripDays();
  const useLiveCurrentLocation = isFirstDay && isCurrentLocationName(itinerary?.start_location_name);
  const originPoint = isFirstDay
    ? startPoint
    : previousStop?.point || startPoint;
  const originMarker = isFirstDay || !previousStop ? "S" : previousStop.marker;
  const destinationPoint = isFinalDay && endPoint
    ? endPoint
    : dayStops[dayStops.length - 1].point;
  const waypointPoints = isFinalDay && endPoint
    ? dayStops.map(item => item.point)
    : dayStops.slice(0, -1).map(item => item.point);
  const destinationMarker = isFinalDay && endPoint ? "E" : "";
  const markerPath = [
    originMarker,
    ...dayStops.map(item => item.marker),
    destinationMarker
  ].filter(Boolean);
  const url = buildGoogleMapsRouteUrl(
    originPoint,
    destinationPoint,
    waypointPoints,
    useLiveCurrentLocation
  );

  return url
    ? {
      url,
      label: `Google Maps ${markerPath.join(" -> ")}`
    }
    : null;
}

async function getRoadRouteGeometry(points) {
  if (!points || points.length < 2) return null;

  const coordinates = points
    .map(point => `${Number(point.longitude)},${Number(point.latitude)}`)
    .join(";");

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3500);
    const response = await fetch(
      `https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=full&geometries=geojson`,
      { signal: controller.signal }
    );
    clearTimeout(timeoutId);

    if (!response.ok) return null;

    const data = await response.json();
    return data?.routes?.[0]?.geometry || null;
  } catch (error) {
    console.error("Edit route map failed:", error);
    return null;
  }
}

const DAY_ROUTE_COLORS = ["#15956f", "#2563eb", "#d97706", "#db2777", "#7c3aed", "#dc2626"];

function getDayRouteColor(dayNumber) {
  return DAY_ROUTE_COLORS[(Math.max(1, Number(dayNumber) || 1) - 1) % DAY_ROUTE_COLORS.length];
}

function getDayRouteDashArray(dayNumber) {
  return [null, "14 8", "4 8", "14 6 3 6", "2 8", "18 4"][
    (Math.max(1, Number(dayNumber) || 1) - 1) % 6
  ];
}

function getDayMapSections(stops) {
  const startPoint = getItineraryPoint("start");
  const endPoint = getItineraryPoint("end");
  const numberedStops = stops.map((stop, index) => ({
    stop,
    marker: index + 1,
    dayNumber: normaliseDayNumber(stop.day_number || stop.day || 1),
    point: getPointFromStop(stop)
  })).filter(item => item.point);
  const dayNumbers = [...new Set(numberedStops.map(item => item.dayNumber))];
  const sections = dayNumbers.map(dayNumber => {
    const dayStops = numberedStops.filter(item => item.dayNumber === dayNumber);
    const previousStop = [...numberedStops].reverse().find(item => item.dayNumber < dayNumber);
    const originPoint = dayNumber === 1
      ? startPoint
      : previousStop?.point || startPoint;
    const points = [originPoint, ...dayStops.map(item => item.point)].filter(Boolean);

    if (dayNumber === getTripDays() && endPoint) {
      points.push(endPoint);
    }

    return { dayNumber, points };
  }).filter(section => section.points.length > 1);

  const lastStop = numberedStops[numberedStops.length - 1];
  if (endPoint && (!lastStop || lastStop.dayNumber < getTripDays())) {
    const originPoint = lastStop?.point || startPoint;
    if (originPoint) {
      sections.push({ dayNumber: getTripDays(), points: [originPoint, endPoint] });
    }
  }

  return sections;
}

async function renderEditRouteMap() {
  const mapElement = document.getElementById("editRouteMap");

  if (!mapElement || typeof L === "undefined") return;

  const mapKey = [
    String(getTripDays()),
    buildCoordinateText(getItineraryPoint("start")),
    ...stopDocs.map(stop => {
      return `${normaliseDayNumber(stop.day_number || stop.day || 1)}:${buildCoordinateText(getPointFromStop(stop))}`;
    }),
    buildCoordinateText(getItineraryPoint("end"))
  ].join("|");

  if (mapKey && mapKey === latestRouteMapKey && editMap) {
    setTimeout(() => {
      editMap?.invalidateSize();
    }, 120);
    return;
  }

  latestRouteMapKey = mapKey;

  if (editMap) {
    editMap.remove();
    editMap = null;
  }

  mapElement.innerHTML = "";

  const mapPoints = [];
  const startPoint = getItineraryPoint("start");
  const endPoint = getItineraryPoint("end");

  if (startPoint) {
    mapPoints.push({
      label: `Start: ${itinerary?.start_location_name || "Start Location"}`,
      latitude: startPoint.latitude,
      longitude: startPoint.longitude,
      type: "start"
    });
  }

  stopDocs.forEach((stop, index) => {
    const point = getPointFromStop(stop);

    if (!point) return;

    mapPoints.push({
      label: `${index + 1}. ${stop.stop_name || "Stop"} (Day ${normaliseDayNumber(stop.day_number || stop.day || 1)})`,
      latitude: point.latitude,
      longitude: point.longitude,
      type: "stop",
      number: index + 1
    });
  });

  if (endPoint) {
    mapPoints.push({
      label: `End: ${itinerary?.end_location_name || itinerary?.destination || "End Location"}`,
      latitude: endPoint.latitude,
      longitude: endPoint.longitude,
      type: "end"
    });
  }

  if (!mapPoints.length) {
    mapElement.innerHTML = `<div class="stop-photo-placeholder">No route coordinates available</div>`;
    return;
  }

  editMap = L.map("editRouteMap");

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(editMap);

  const markerGroup = L.featureGroup();

  mapPoints.forEach(point => {
    const markerLabel = point.type === "start"
      ? "S"
      : point.type === "end"
        ? "E"
        : String(point.number || "");

    const icon = L.divIcon({
      className: "",
      html: `<div class="edit-map-marker ${escapeHtml(point.type)}">${escapeHtml(markerLabel)}</div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
      popupAnchor: [0, -16]
    });

    const zIndexOffset = point.type === "start"
      ? 1000
      : point.type === "end"
        ? 900
        : Math.max(0, 500 - Number(point.number || 0));
    const marker = L.marker([point.latitude, point.longitude], { icon, zIndexOffset })
      .bindPopup(point.label)
      .addTo(editMap);

    markerGroup.addLayer(marker);
  });

  const requestId = activeRouteMapRequest + 1;
  activeRouteMapRequest = requestId;
  const daySections = getDayMapSections(stopDocs);
  const routeGeometries = await Promise.all(
    daySections.map(section => getRoadRouteGeometry(section.points))
  );

  if (requestId !== activeRouteMapRequest || !editMap) {
    return;
  }

  daySections.forEach((section, index) => {
    const style = {
      color: getDayRouteColor(section.dayNumber),
      weight: 5,
      opacity: .85,
      dashArray: getDayRouteDashArray(section.dayNumber),
      lineCap: "round",
      lineJoin: "round"
    };
    const geometry = routeGeometries[index];
    const layer = geometry
      ? L.geoJSON(geometry, { style }).addTo(editMap)
      : L.polyline(
        section.points.map(point => [point.latitude, point.longitude]),
        style
      ).addTo(editMap);

    layer.bindTooltip(`Day ${section.dayNumber}`);
  });

  if (mapPoints.length === 1) {
    editMap.setView([mapPoints[0].latitude, mapPoints[0].longitude], 14);
  } else {
    editMap.fitBounds(markerGroup.getBounds(), {
      padding: [24, 24]
    });
  }

  setTimeout(() => {
    editMap?.invalidateSize();
  }, 120);
}

function scheduleEditRouteMapRender() {
  clearTimeout(routeMapRenderTimer);
  routeMapRenderTimer = setTimeout(() => {
    renderEditRouteMap().catch(console.error);
  }, 350);
}

async function getOsrmLegMinutes(points) {
  if (!points || points.length < 2) return [];

  const coordinates = points
    .map(point => `${Number(point.longitude)},${Number(point.latitude)}`)
    .join(";");

  const response = await fetch(
    `https://router.project-osrm.org/route/v1/driving/${coordinates}?overview=false&steps=false`
  );

  if (!response.ok) {
    throw new Error("Could not calculate route timing.");
  }

  const data = await response.json();
  const legs = data?.routes?.[0]?.legs || [];

  return legs.map(leg => Math.max(0, Math.round(Number(leg.duration || 0) / 60)));
}

async function recalculateStopTimesWithOsrm(stops) {
  const startPoint = getItineraryPoint("start");
  const endPoint = getItineraryPoint("end");
  const canUseOsrm = Boolean(startPoint) && stops.every(hasValidStopCoordinates);
  const routePoints = canUseOsrm
    ? [
      startPoint,
      ...stops.map(stop => ({
        latitude: Number(stop.latitude),
        longitude: Number(stop.longitude)
      })),
      endPoint
    ].filter(Boolean)
    : [];

  let legMinutes = [];

  try {
    legMinutes = await getOsrmLegMinutes(routePoints);
  } catch (error) {
    console.error("OSRM timing failed, using coordinate estimate:", error);
  }

  let currentDay = 1;
  let cursor = parseClockMinutes(getDayStartTime(1));
  let previousPoint = startPoint || {
    latitude: itinerary?.start_latitude,
    longitude: itinerary?.start_longitude
  };
  let totalTravelMinutes = 0;

  const recalculatedStops = stops.map((stop, index) => {
    const dayNumber = normaliseDayNumber(stop.day_number || stop.day || 1);
    if (index === 0 || dayNumber !== currentDay) {
      currentDay = dayNumber;
      cursor = parseClockMinutes(getDayStartTime(dayNumber));
    }

    const visitMinutes = Math.max(0, Number(stop.visit_duration_minutes || 0));
    const travelMinutes = Number.isFinite(Number(legMinutes[index]))
      ? Number(legMinutes[index])
      : estimateTravelMinutes(previousPoint, stop);
    const arrivalMinutes = cursor + travelMinutes;
    const departureMinutes = arrivalMinutes + visitMinutes;

    totalTravelMinutes += travelMinutes;
    previousPoint = stop;
    cursor = departureMinutes;

    return {
      ...stop,
      day_number: dayNumber,
      stop_order: index + 1,
      travel_minutes_from_previous: travelMinutes,
      arrival_time: formatClockMinutes(arrivalMinutes),
      departure_time: formatClockMinutes(departureMinutes),
      visit_duration_minutes: visitMinutes
    };
  });

  const finalLegIndex = stops.length;
  const finalTravelMinutes = Number.isFinite(Number(legMinutes[finalLegIndex]))
    ? Number(legMinutes[finalLegIndex])
    : endPoint && previousPoint
      ? estimateTravelMinutes(previousPoint, endPoint)
      : 0;

  totalTravelMinutes += finalTravelMinutes;

  return {
    stops: recalculatedStops,
    finalTravelMinutes,
    travelMinutes: totalTravelMinutes,
    totalMinutes: totalTravelMinutes + recalculatedStops.reduce((total, stop) => {
      return total + Number(stop.visit_duration_minutes || 0);
    }, 0)
  };
}

function getTotalRouteMinutes(stops) {
  return stops.reduce((total, stop) => {
    return total
      + Number(stop.travel_minutes_from_previous || 0)
      + Number(stop.visit_duration_minutes || 0);
  }, 0);
}

function getStoredFinalTravelMinutes(stops) {
  const savedTravelMinutes = Number(itinerary?.travel_duration_minutes || 0);
  const stopTravelMinutes = stops.reduce((total, stop) => {
    return total + Number(stop.travel_minutes_from_previous || 0);
  }, 0);
  return Math.max(0, savedTravelMinutes - stopTravelMinutes);
}

function getTotalRouteMinutesWithFinalLeg(stops) {
  return getTotalRouteMinutes(stops) + getStoredFinalTravelMinutes(stops);
}

function formatRelativeTime(value) {
  const time = timestampMillis(value);
  if (!time) return "";
  const diffSeconds = Math.max(1, Math.floor((Date.now() - time) / 1000));
  if (diffSeconds < 60) return "just now";
  const diffMinutes = Math.floor(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

function initials(nameOrEmail) {
  const text = String(nameOrEmail || "?").trim();
  return text.charAt(0).toUpperCase() || "?";
}

function setInviteMessage(message, isError = false) {
  if (!inviteMessage) return;
  inviteMessage.textContent = message || "";
  inviteMessage.style.color = isError ? "#dc2626" : "";
}

function setCommentMessage(message, isError = false) {
  if (!commentMessage) return;
  commentMessage.textContent = message || "";
  commentMessage.style.color = isError ? "#dc2626" : "";
}

function setRouteSaveMessage(message, isError = false) {
  if (!routeSaveMessage) return;
  routeSaveMessage.textContent = message || "";
  routeSaveMessage.style.color = isError ? "#dc2626" : "";
}

function isBusy(action = "") {
  return busyAction && (!action || busyAction === action);
}

async function runBusyAction(action, buttonElement, busyText, callback) {
  if (busyAction) return;
  busyAction = action;

  const originalText = buttonElement?.textContent;
  if (buttonElement) {
    buttonElement.disabled = true;
    if (busyText) buttonElement.textContent = busyText;
  }
  updateAddStopButtonState();

  try {
    return await callback();
  } finally {
    if (buttonElement) {
      buttonElement.disabled = false;
      if (originalText && buttonElement.dataset.confirmFar !== "1") {
        buttonElement.textContent = originalText;
      }
    }
    busyAction = "";
    updateAddStopButtonState();
  }
}

function describeRouteCalculation(stopCount) {
  return stopCount > 4
    ? "Calculating route timing. Larger routes can take a moment..."
    : "Calculating route timing...";
}

function getFarTravelLegMessage(timing) {
  const legMinutes = [
    ...timing.stops.map(stop => Number(stop.travel_minutes_from_previous || 0)),
    Number(timing.finalTravelMinutes || 0)
  ];
  const farLegIndex = legMinutes.findIndex(minutes => minutes > MAX_TRAVEL_LEG_MINUTES);

  if (farLegIndex === -1) return "";

  return `This stop is very far from the previous stop. Travel time is ${formatMinutesAsDuration(legMinutes[farLegIndex])}.`;
}

function showFarStopConfirmation(warningElement, saveButton, message) {
  if (warningElement) {
    warningElement.textContent = `${message} Are you sure you want to save it?`;
    warningElement.classList.add("show");
  }
  if (saveButton) {
    saveButton.dataset.confirmFar = "1";
    saveButton.textContent = "Save anyway";
  }
}

function clearFarStopConfirmation(warningElement, saveButton) {
  if (warningElement) {
    warningElement.textContent = "";
    warningElement.classList.remove("show");
  }
  if (saveButton) {
    delete saveButton.dataset.confirmFar;
    saveButton.textContent = "Save changes";
  }
}

function showStopValidationError(warningElement, message) {
  if (!warningElement) return;
  warningElement.textContent = message;
  warningElement.classList.add("show");
}

function clearStopValidationError(warningElement) {
  if (!warningElement || warningElement.dataset.confirmation === "1") return;
  warningElement.textContent = "";
  warningElement.classList.remove("show");
}

function stopsHaveSameRoute(previousStops, nextStops) {
  if (previousStops.length !== nextStops.length) return false;

  return previousStops.every((stop, index) => {
    const nextStop = nextStops[index];
    if (!nextStop) return false;
    return (
      stop.document_id === nextStop.document_id
      && Number(stop.day_number || 1) === Number(nextStop.day_number || 1)
      && Number(stop.latitude) === Number(nextStop.latitude)
      && Number(stop.longitude) === Number(nextStop.longitude)
    );
  });
}

function showSuggestionStatus(boxElement, message, itemClass = "stop-suggestion-item", subClass = "stop-suggestion-sub") {
  if (!boxElement) return;
  boxElement.hidden = false;
  boxElement.innerHTML = `<div class="${itemClass}"><span class="${subClass}">${escapeHtml(message)}</span></div>`;
}

function hideSuggestions(boxElement) {
  if (!boxElement) return;
  boxElement.hidden = true;
  boxElement.innerHTML = "";
}

function setEditingState() {
  currentRole = isOwner ? "owner" : "viewer";

  if (!isOwner) {
    const collaborator = collaboratorDocs.find(item => item.user_id === currentUser.uid);
    currentRole = collaborator?.role || "viewer";
  }

  canEdit = ["owner", "editor"].includes(currentRole);
  if (roleBadge) roleBadge.textContent = currentRole.charAt(0).toUpperCase() + currentRole.slice(1);
  [
    titleInput,
    dateInput,
    daysInput,
    routeStartInput,
    routeEndInput,
    routeHoursInput,
    routeHoursUnlimitedInput,
    saveRouteDetailsButton,
    addStopButton,
    inviteEmailInput
  ].forEach(element => {
    if (element) element.disabled = !canEdit;
  });
  routeInterestInput?.querySelectorAll('input[name="route_interests"]').forEach(input => {
    input.disabled = !canEdit;
  });
  updateAddStopButtonState();
}

function updateAddStopButtonState() {
  if (!addStopButton) return;
  const isAtStopLimit = stopDocs.length >= MAX_EDIT_STOPS;
  const currentTotalMinutes = getTotalRouteMinutesWithFinalLeg(recalculateStopTimesWithExistingTravel(stopDocs));
  const overageMessage = getRouteOverageMessage(currentTotalMinutes);
  addStopButton.disabled = !canEdit || Boolean(draftStop) || Boolean(busyAction) || isAtStopLimit || Boolean(overageMessage);
  addStopButton.hidden = isAtStopLimit;
  if (isAtStopLimit) {
    addStopButton.textContent = `Cannot add more than ${MAX_EDIT_STOPS} stops`;
  } else if (overageMessage) {
    addStopButton.textContent = "Increase available time to add stops";
  } else {
    addStopButton.textContent = draftStop ? "Finish current stop first" : "+ Add a stop";
  }
}

function scrollToEditingStop() {
  if (!stopList || !editingStopId) return;

  window.setTimeout(function () {
    const row = stopList.querySelector(`[data-stop-id="${editingStopId}"]`);

    if (row) {
      row.scrollIntoView({
        behavior: "smooth",
        block: "center"
      });
    }
  }, 50);
}

async function ensureOwnerCollaborator() {
  if (!itinerary || !currentUser || !isOwner) {
    return;
  }

  const ownerDocumentId =
    collaboratorDocumentId(
      itinerary.document_id,
      currentUser.uid
    );

  const alreadyExists =
    collaboratorDocs.some(
      item =>
        item.document_id === ownerDocumentId
    );

  if (alreadyExists) {
    return;
  }

  const ownerName =
    currentUserDisplayName();

  const ownerRef = doc(
    db,
    COLLABORATOR_COLLECTION,
    ownerDocumentId
  );
  await setDoc(ownerRef, {
    collaborator_id: ownerRef.id,
    itinerary_id: activeItineraryId,
    itinerary_document_id: itinerary.document_id,
    user_id: currentUser.uid,
    email: normaliseEmail(currentUser.email),
    display_name: ownerName,
    role: "owner",
    status: "accepted",
    last_activity_viewed_at: serverTimestamp(),
    last_comments_viewed_at: serverTimestamp(),
    created_at: serverTimestamp(),
    updated_at: serverTimestamp()
  });
}

async function addActivity(type, message) {
  if (!itinerary || !currentUser) return;
  const actorName = currentUserDisplayName();
  await addDoc(collection(db, NOTIFICATION_COLLECTION), {
    itinerary_id: activeItineraryId,
    itinerary_document_id: itinerary.document_id,
    actor_id: currentUser.uid,
    actor_name: actorName,
    type,
    message,
    created_at: serverTimestamp()
  });
}

function markTripDetailsDirty() {
  if (canEdit) {
    tripDetailsDirty = true;
  }
}

function renderItinerary() {
  if (!itinerary) return;
  if (!tripDetailsDirty && titleInput && document.activeElement !== titleInput && titleInput.value !== (itinerary.title || "")) {
    titleInput.value = itinerary.title || "Untitled Trip";
  }
  if (!tripDetailsDirty && dateInput && document.activeElement !== dateInput && dateInput.value !== (itinerary.travel_date || "")) {
    dateInput.value = itinerary.travel_date || "";
  }
  if (!tripDetailsDirty && daysInput && document.activeElement !== daysInput) {
    daysInput.value = String(getTripDays());
    daysInput.disabled = !canEdit;
  }
  if (dateRangeText) {
    dateRangeText.textContent = formatTripDateRange();
  }
  if (!tripDetailsDirty && !dayStartGrid?.contains(document.activeElement)) {
    renderDayStartControls();
  }
  if (!tripDetailsDirty && routeStartInput && document.activeElement !== routeStartInput) {
    routeStartInput.value = itinerary.start_location_name || "";
  }
  if (!tripDetailsDirty && routeEndInput && document.activeElement !== routeEndInput) {
    routeEndInput.value = itinerary.end_location_name || itinerary.destination || "";
  }
  if (!tripDetailsDirty && routeHoursInput && document.activeElement !== routeHoursInput) {
    routeHoursInput.value = itinerary.available_hours_unlimited ? "" : itinerary.available_hours || "";
    routeHoursInput.disabled = !canEdit || isRouteTimeUnlimited();
  }
  if (!tripDetailsDirty && routeHoursUnlimitedInput) {
    routeHoursUnlimitedInput.checked = isRouteTimeUnlimited();
  }
  if (!tripDetailsDirty && routeInterestInput && !routeInterestInput.contains(document.activeElement)) {
    const savedInterests = getSavedInterests();
    routeInterestInput.querySelectorAll('input[name="route_interests"]').forEach(input => {
      input.checked = savedInterests.includes(normaliseInterest(input.value));
    });
  }
  const calculatedMinutes = getTotalRouteMinutesWithFinalLeg(recalculateStopTimesWithExistingTravel(stopDocs));

  if (hoursText) hoursText.textContent = formatMinutesAsDuration(calculatedMinutes);
  if (stopCountText) stopCountText.textContent = `${stopDocs.length} stops`;
  renderTripPhoto().catch(console.error);
  scheduleEditRouteMapRender();
}

async function renderTripPhoto() {
  const photoElement = document.getElementById("edit-trip-photo");

  if (!photoElement) return;

  const photoStops = getPhotoStops(getTripPhotoCandidates());

  if (!photoStops.length) {
    photoElement.innerHTML = `<div class="stop-photo-placeholder">No photo available</div>`;
    return;
  }

  const selectedStop = photoStops.find(stop => {
    return stop.document_id === selectedTripPhotoStopId;
  });
  const activeStop = selectedStop || photoStops[0];
  selectedTripPhotoStopId = activeStop.document_id || "";

  const placeName = getStopPlaceName(activeStop);
  const tripPhotoKey = `${activeStop.document_id}:${placeName}`;

  if (tripPhotoKey === latestTripPhotoKey && photoElement.querySelector("img")) {
    return;
  }

  latestTripPhotoKey = tripPhotoKey;
  const photo = await getPlacePhoto(placeName);

  photoElement.innerHTML = photo.imageUrl
    ? `
      <img src="${escapeHtml(photo.imageUrl)}" alt="${escapeHtml(photo.placeName)}" loading="lazy">
      <div class="edit-trip-photo-label">${escapeHtml(photo.placeName)}</div>
    `
    : `<div class="stop-photo-placeholder">No photo available</div>`;

  document.querySelectorAll(".stop-photo").forEach(element => {
    element.classList.toggle(
      "is-selected",
      element.dataset.stopId === selectedTripPhotoStopId
    );
  });
}

async function renderStopPhoto(stop, index) {
  const photoElement = document.querySelector(`[data-stop-photo="${index}"]`);

  if (!photoElement) return;

  const placeName = getStopPlaceName(stop);
  photoElement.dataset.placeName = placeName;

  if (!placeName || isGenericLocationName(placeName)) {
    photoElement.innerHTML = `<div class="stop-photo-placeholder">No photo</div>`;
    return;
  }

  if (placePhotoHtmlCache.has(placeName)) {
    photoElement.innerHTML = placePhotoHtmlCache.get(placeName);
    return;
  }

  const photo = await getPlacePhoto(placeName);

  if (photoElement.dataset.placeName !== placeName) {
    return;
  }

  const photoHtml = photo.imageUrl
    ? `<img src="${escapeHtml(photo.imageUrl)}" alt="${escapeHtml(photo.placeName)}" loading="lazy">`
    : `<div class="stop-photo-placeholder">No photo</div>`;

  placePhotoHtmlCache.set(placeName, photoHtml);
  photoElement.innerHTML = photoHtml;
}

function getInitialStopPhotoHtml(stop) {
  const placeName = getStopPlaceName(stop);

  if (!placeName || isGenericLocationName(placeName)) {
    return `<div class="stop-photo-placeholder">No photo</div>`;
  }

  return placePhotoHtmlCache.get(placeName) || `<div class="stop-photo-placeholder">Loading</div>`;
}

function sortByCreatedDesc(items) {
  return [...items].sort((a, b) => timestampMillis(b.created_at) - timestampMillis(a.created_at));
}

function renderStops() {
  if (!stopList) return;
  if (stopDocs.length >= MAX_EDIT_STOPS && draftStop) {
    draftStop = null;
    if (editingStopId === "__draft_stop__") {
      editingStopId = "";
    }
  }
  const editableStops = draftStop ? [...stopDocs, draftStop] : stopDocs;
  const calculatedStops = recalculateStopTimesWithExistingTravel(editableStops);
  const routeMarkers = getRouteMarkerRows(calculatedStops);
  const visibleStops = [
    ...(routeMarkers[0] ? [routeMarkers[0]] : []),
    ...editableStops,
    ...(routeMarkers[1] ? [routeMarkers[1]] : [])
  ];
  const dayOptions = Array.from({ length: getTripDays() }, (_, index) => index + 1)
    .map(dayNumber => `<option value="${dayNumber}">Day ${dayNumber}</option>`)
    .join("");
  let lastRenderedDay = 0;
  stopList.classList.remove("is-scrollable");
  updateAddStopButtonState();
  if (stopCountText) stopCountText.textContent = `${stopDocs.length} stops`;

  if (!visibleStops.length) {
    stopList.innerHTML = `<div class="empty-soft">No stops yet.</div>`;
    return;
  }

  stopList.innerHTML = "";
  visibleStops.forEach((stop, index) => {
    const isDraft = stop.document_id === "__draft_stop__";
    const isRouteMarker = Boolean(stop.routeMarkerType);
    const editableIndex = editableStops.findIndex(item => {
      return item.document_id === stop.document_id;
    });
    const row = document.createElement("div");
    row.className = `edit-stop-row ${isRouteMarker ? "route-marker-row" : ""}`;
    if (editingStopId === stop.document_id) row.classList.add("is-editing");
    row.draggable = canEdit && !isDraft && !isRouteMarker;
    row.dataset.stopId = stop.document_id;
    const calculatedStop = editableIndex >= 0
      ? calculatedStops[editableIndex] || stop
      : stop;
    const durationText = Number(calculatedStop.visit_duration_minutes || 0)
      ? `${Number(calculatedStop.visit_duration_minutes || 0)} mins visit`
      : "Estimated";
    const travelText = Number(calculatedStop.travel_minutes_from_previous || 0)
      ? `, ${Number(calculatedStop.travel_minutes_from_previous || 0)} mins travel`
      : "";
    const timeText = isRouteMarker
      ? stop.routeMarkerSubtitle
      : calculatedStop.arrival_time
      ? `${calculatedStop.arrival_time} - ${calculatedStop.departure_time || ""} - ${durationText}${travelText}`
      : durationText;
    const initialPhotoHtml = getInitialStopPhotoHtml(stop);
    let googleMapsButton = "";

    if (!isRouteMarker) {
      const originPoint = editableIndex === 0
        ? getItineraryPoint("start")
        : getPointFromStop(editableStops[editableIndex - 1]);
      const destinationPoint = getPointFromStop(stop);
      const useLiveCurrentLocation =
        editableIndex === 0 &&
        isCurrentLocationName(itinerary?.start_location_name);
      const googleMapsUrl = buildGoogleMapsUrl(
        originPoint,
        destinationPoint,
        useLiveCurrentLocation
      );
      const originLabel = editableIndex === 0
        ? itinerary?.start_location_name || "Start Location"
        : editableStops[editableIndex - 1]?.stop_name || "Previous Stop";
      const segmentLabel = getRouteSegmentLabel(
        editableIndex === 0 ? "S" : String(editableIndex),
        String(editableIndex + 1)
      );

      googleMapsButton = googleMapsUrl
        ? `
          <div class="stop-route-action">
            <a
              href="${escapeHtml(googleMapsUrl)}"
              target="_blank"
              rel="noopener noreferrer"
              class="btn btn-secondary btn-sm"
              title="Google Maps: ${escapeHtml(originLabel)} -> ${escapeHtml(stop.stop_name || "Stop")}"
            >
              ${escapeHtml(segmentLabel)}
            </a>
          </div>
        `
        : "";
    }

    if (!isRouteMarker && editableIndex === editableStops.length - 1) {
      const endPoint = getItineraryPoint("end");
      const lastStopPoint = getPointFromStop(stop);
      const endMapsUrl = buildGoogleMapsUrl(lastStopPoint, endPoint);
      const endName = itinerary?.end_location_name || itinerary?.destination || "End Location";

      if (endMapsUrl) {
        const returnSegmentLabel = getRouteSegmentLabel(String(editableIndex + 1), "E");

        googleMapsButton += `
          <div class="stop-route-action">
            <a
              href="${escapeHtml(endMapsUrl)}"
              target="_blank"
              rel="noopener noreferrer"
              class="btn btn-secondary btn-sm"
              title="Google Maps: ${escapeHtml(stop.stop_name || "Stop")} -> ${escapeHtml(endName)}"
            >
              ${escapeHtml(returnSegmentLabel)}
            </a>
          </div>
        `;
      }
    }

    const dayNumber = isRouteMarker ? 0 : normaliseDayNumber(stop.day_number || stop.day || 1);
    const dayRoute = !isRouteMarker && dayNumber !== lastRenderedDay
      ? getDayRouteGoogleMaps(dayNumber, editableStops)
      : null;
    const dayDivider = !isRouteMarker && dayNumber !== lastRenderedDay
      ? `
        <div class="day-divider">
          <span>Day ${dayNumber} - starts ${escapeHtml(formatClockMinutes(parseClockMinutes(getDayStartTime(dayNumber))))}</span>
          ${dayRoute
            ? `<a href="${escapeHtml(dayRoute.url)}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-sm day-route-link">${escapeHtml(dayRoute.label)}</a>`
            : ""}
        </div>
      `
      : "";
    if (!isRouteMarker && dayNumber !== lastRenderedDay) {
      lastRenderedDay = dayNumber;
    }

    row.innerHTML = `
      ${dayDivider}
      <div class="stop-number" title="${isRouteMarker ? stop.routeMarkerType : "Drag to reorder"}">${isRouteMarker ? (stop.routeMarkerType === "Start" ? "S" : "E") : editableIndex + 1}</div>
      <div class="stop-main">
        <div class="stop-display">
          <button
            type="button"
            class="stop-photo"
            data-stop-photo="${index}"
            data-stop-id="${escapeHtml(stop.document_id)}"
            aria-label="Show ${escapeHtml(stop.stop_name || "stop")} photo"
          >
            ${initialPhotoHtml}
          </button>
          <div class="stop-text">
            ${isRouteMarker ? `<div class="route-marker-label">${escapeHtml(stop.routeMarkerType)}</div>` : ""}
            <div class="stop-title">${escapeHtml(stop.stop_name || "Unnamed Stop")}</div>
            <div class="stop-subtitle">${escapeHtml(timeText)}</div>
            ${googleMapsButton}
          </div>
          ${canEdit && !isRouteMarker ? `
            <div class="stop-actions-inline">
              <button type="button" class="btn btn-secondary btn-sm js-edit-stop">${editingStopId === stop.document_id ? "Close" : "Edit"}</button>
              <button type="button" class="icon-trash-btn stop-trash-btn js-delete-stop" aria-label="${isDraft ? "Cancel new stop" : "Remove stop"}" title="${isDraft ? "Cancel new stop" : "Remove stop"}">
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3 6h18"></path>
                  <path d="M8 6V4h8v2"></path>
                  <path d="M6 6l1 15h10l1-15"></path>
                  <path d="M10 10v7"></path>
                  <path d="M14 10v7"></path>
                </svg>
              </button>
            </div>
          ` : ""}
        </div>
        ${isRouteMarker ? "" : `
        <div class="stop-edit-panel">
          <div class="stop-fields">
            <div class="stop-field">
              <label>Stop name</label>
              <div class="stop-place-picker">
                <input class="stop-input js-stop-name" type="text" value="${escapeHtml(stop.stop_name || "")}" ${canEdit ? "" : "disabled"} aria-label="Stop name" autocomplete="off">
                <div class="stop-suggestions js-stop-suggestions" hidden></div>
              </div>
            </div>
            <div class="stop-field">
              <label>Day</label>
              <select class="stop-day-select js-stop-day" ${canEdit ? "" : "disabled"} aria-label="Stop day">
                ${dayOptions}
              </select>
            </div>
            <div class="stop-field">
              <label>Calculated time</label>
              <input class="stop-input js-stop-arrival" type="text" value="${escapeHtml(calculatedStop.arrival_time || "")}" disabled aria-label="Calculated arrival time">
            </div>
            <div class="stop-field">
              <label>Visit minutes</label>
              <input class="stop-input js-stop-duration" type="number" min="0" step="5" value="${escapeHtml(stop.visit_duration_minutes || 0)}" ${canEdit ? "" : "disabled"} aria-label="Visit duration minutes">
            </div>
          </div>
          <div class="stop-row-actions">
            <button type="button" class="btn btn-primary btn-sm js-save-stop">Save changes</button>
            <button type="button" class="btn btn-secondary btn-sm js-cancel-stop">Cancel</button>
          </div>
          <div class="stop-warning js-stop-warning" aria-live="polite"></div>
        </div>
        `}
      </div>
    `;

    const daySelect = row.querySelector(".js-stop-day");
    if (daySelect) {
      daySelect.value = String(dayNumber || 1);
    }

    row.addEventListener("dragstart", function () {
      if (isDraft || isRouteMarker) return;
      draggedStopId = stop.document_id;
      row.classList.add("dragging");
    });
    row.addEventListener("dragend", function () {
      draggedStopId = "";
      row.classList.remove("dragging");
    });
    row.addEventListener("dragover", function (event) {
      if (canEdit) event.preventDefault();
    });
    row.addEventListener("drop", function (event) {
      event.preventDefault();
      if (!canEdit || isRouteMarker || !draggedStopId || draggedStopId === stop.document_id) return;
      runBusyAction(
        "reorder-stops",
        null,
        "",
        () => reorderStops(draggedStopId, stop.document_id)
      ).catch(console.error);
    });

    row.querySelector(".js-edit-stop")?.addEventListener("click", function () {
      editingStopId = editingStopId === stop.document_id ? "" : stop.document_id;
      renderStops();
      scrollToEditingStop();
    });

    row.querySelector(".js-cancel-stop")?.addEventListener("click", function () {
      editingStopId = "";
      renderStops();
    });

    row.querySelector(".js-save-stop")?.addEventListener("click", function (event) {
      const nameInput = row.querySelector(".js-stop-name");
      const durationInput = row.querySelector(".js-stop-duration");
      const dayInput = row.querySelector(".js-stop-day");
      const saveButton = event.currentTarget;
      const warningElement = row.querySelector(".js-stop-warning");
      const placeChanges = getSelectedStopPlaceChanges(stop.document_id);

      const changes = {
        stop_name: nameInput?.value.trim() || "Unnamed Stop",
        day_number: normaliseDayNumber(dayInput?.value || 1),
        visit_duration_minutes: Number(durationInput?.value || 0),
        ...placeChanges
      };

      runBusyAction(
        isDraft ? "create-stop" : `save-stop:${stop.document_id}`,
        saveButton,
        "Saving...",
        () => isDraft
          ? createStopFromDraft(editableIndex + 1, changes, saveButton?.dataset.confirmFar === "1", warningElement, saveButton)
          : saveStopChanges(stop.document_id, editableIndex + 1, changes, saveButton?.dataset.confirmFar === "1", warningElement, saveButton)
      ).catch(console.error);
    });

    row.querySelector(".js-delete-stop")?.addEventListener("click", function () {
      const stopName = stop.stop_name || "this stop";
      if (isDraft) {
        draftStop = null;
        editingStopId = "";
        renderStops();
        return;
      }
      openConfirmModal(
        "Remove stop?",
        `Remove ${stopName} from this itinerary? This action cannot be undone.`,
        () => deleteStop(stop.document_id, stopName)
      );
    });

    row.querySelector(".stop-photo")?.addEventListener("click", function () {
      selectedTripPhotoStopId = stop.document_id;
      renderTripPhoto().catch(console.error);
    });

    setupStopPlaceAutocomplete(row, stop.document_id, stop);
    stopList.appendChild(row);
    setTimeout(() => {
      renderStopPhoto(stop, index).catch(console.error);
    }, Math.min(index * 120, 900));
  });
}

async function updateStop(stopDocumentId, changes, activityText) {
  if (!canEdit) return;
  await updateDoc(doc(db, STOP_COLLECTION, stopDocumentId), {
    ...changes,
    updated_at: serverTimestamp()
  });
  await addActivity("stop_updated", `${currentUserDisplayName()} ${activityText}`);
}

function getRoutePlace(fieldName, inputElement, currentName, latitudeKey, longitudeKey) {
  const typedName = String(inputElement?.value || "").trim();
  const existingName = String(currentName || "").trim();
  const selectedPlace = selectedRoutePlaces[fieldName];

  if (selectedPlace) {
    return {
      name: selectedPlace.display_name || typedName,
      latitude: Number(selectedPlace.latitude),
      longitude: Number(selectedPlace.longitude)
    };
  }

  if (typedName && typedName === existingName) {
    return {
      name: typedName,
      latitude: Number(itinerary?.[latitudeKey]),
      longitude: Number(itinerary?.[longitudeKey])
    };
  }

  return {
    name: typedName,
    latitude: NaN,
    longitude: NaN
  };
}

function normaliseCompareText(value) {
  return String(value ?? "").trim();
}

function normaliseCompareArray(values) {
  return (Array.isArray(values) ? values : [])
    .map(value => normaliseCompareText(value).toLowerCase())
    .filter(Boolean)
    .sort();
}

function sameCompareArray(first, second) {
  const firstValues = normaliseCompareArray(first);
  const secondValues = normaliseCompareArray(second);
  return firstValues.length === secondValues.length
    && firstValues.every((value, index) => value === secondValues[index]);
}

function sameDayStartTimes(first, second, days) {
  for (let dayNumber = 1; dayNumber <= days; dayNumber += 1) {
    if (normaliseCompareText(first?.[String(dayNumber)]) !== normaliseCompareText(second?.[String(dayNumber)])) {
      return false;
    }
  }

  return true;
}

function getComparableDayStartTimes(source, days) {
  const savedTimes = source?.day_start_times && typeof source.day_start_times === "object"
    ? source.day_start_times
    : {};
  const fallbackTime = source?.start_time || "09:00";
  const result = {};

  for (let dayNumber = 1; dayNumber <= days; dayNumber += 1) {
    result[String(dayNumber)] = savedTimes[String(dayNumber)] || fallbackTime;
  }

  return result;
}

function describeTripDetailChanges(previousItinerary, nextDetails) {
  const changed = [];
  const previousDays = Number(previousItinerary?.trip_days || previousItinerary?.day_count || 1);
  const nextDays = Number(nextDetails.trip_days || 1);

  if (normaliseCompareText(previousItinerary?.title || "Untitled Trip") !== normaliseCompareText(nextDetails.title)) {
    changed.push("title");
  }

  if (normaliseCompareText(previousItinerary?.travel_date) !== normaliseCompareText(nextDetails.travel_date)) {
    changed.push("travel date");
  }

  if (previousDays !== nextDays) {
    changed.push("trip days");
  }

  if (!sameDayStartTimes(getComparableDayStartTimes(previousItinerary, nextDays), nextDetails.day_start_times || {}, nextDays)) {
    changed.push("day start times");
  }

  if (normaliseCompareText(previousItinerary?.start_location_name) !== normaliseCompareText(nextDetails.start_location_name)) {
    changed.push("start location");
  }

  if (
    normaliseCompareText(previousItinerary?.end_location_name || previousItinerary?.destination)
    !== normaliseCompareText(nextDetails.end_location_name || nextDetails.destination)
  ) {
    changed.push("end location");
  }

  if (Boolean(previousItinerary?.available_hours_unlimited) !== Boolean(nextDetails.available_hours_unlimited)) {
    changed.push("time limit");
  } else if (normaliseCompareText(previousItinerary?.available_hours) !== normaliseCompareText(nextDetails.available_hours)) {
    changed.push("available hours");
  }

  if (!sameCompareArray(previousItinerary?.interests, nextDetails.interests)) {
    changed.push("interests");
  }

  return changed;
}

async function saveRouteDetails() {
  if (!canEdit || !itinerary) return;

  const startPlace = getRoutePlace(
    "start",
    routeStartInput,
    itinerary.start_location_name,
    "start_latitude",
    "start_longitude"
  );
  const endPlace = getRoutePlace(
    "end",
    routeEndInput,
    itinerary.end_location_name || itinerary.destination,
    "end_latitude",
    "end_longitude"
  );
  const unlimitedHours = Boolean(routeHoursUnlimitedInput?.checked);
  const availableHours = unlimitedHours
    ? ""
    : Math.max(1, Number(routeHoursInput?.value || itinerary.available_hours || 1));
  const interests = getSelectedRouteInterests();
  const interest = interests[0] || "";
  const tripDays = getTripDays();
  const travelDate = dateInput?.value || itinerary.travel_date || "";
  const endTravelDate = addDaysToDate(travelDate, tripDays - 1);
  const dayStartTimes = getDayStartTimesFromInputs(tripDays);
  const title = titleInput?.value.trim() || "Untitled Trip";

  if (!startPlace.name || !endPlace.name) {
    setRouteSaveMessage("Start and end location are required.", true);
    return;
  }

  if (!Number.isFinite(startPlace.latitude) || !Number.isFinite(startPlace.longitude)) {
    setRouteSaveMessage("Please choose the start location from the suggestions.", true);
    return;
  }

  if (!Number.isFinite(endPlace.latitude) || !Number.isFinite(endPlace.longitude)) {
    setRouteSaveMessage("Please choose the end location from the suggestions.", true);
    return;
  }

  if (!interests.length) {
    setRouteSaveMessage("Please choose at least one interest.", true);
    return;
  }

  setRouteSaveMessage(describeRouteCalculation(stopDocs.length));
  const previousItinerary = itinerary;
  const changedDetails = describeTripDetailChanges(previousItinerary, {
    title,
    travel_date: travelDate,
    trip_days: tripDays,
    day_start_times: dayStartTimes,
    start_location_name: startPlace.name,
    end_location_name: endPlace.name,
    destination: endPlace.name,
    available_hours: availableHours,
    available_hours_unlimited: unlimitedHours,
    interest,
    interests
  });
  itinerary = {
    ...itinerary,
    title,
    start_location_name: startPlace.name,
    start_latitude: startPlace.latitude,
    start_longitude: startPlace.longitude,
    end_location_name: endPlace.name,
    end_latitude: endPlace.latitude,
    end_longitude: endPlace.longitude,
    destination: endPlace.name,
    travel_date: travelDate,
    available_hours: availableHours,
    available_hours_unlimited: unlimitedHours,
    trip_days: tripDays,
    end_travel_date: endTravelDate,
    day_start_times: dayStartTimes,
    start_time: dayStartTimes["1"] || itinerary.start_time || "09:00",
    interest,
    interests
  };

  try {
    const timing = await recalculateStopTimesWithOsrm(stopDocs);
    const overageMessage = getRouteOverageMessage(timing.totalMinutes);
    if (overageMessage) {
      itinerary = previousItinerary;
      setRouteSaveMessage(overageMessage, true);
      return;
    }
    const batch = writeBatch(db);

    stopDocs.forEach((stop, index) => {
      const recalculatedStop = timing.stops[index];
      if (!recalculatedStop) return;
      batch.update(doc(db, STOP_COLLECTION, stop.document_id), {
        day_number: recalculatedStop.day_number || 1,
        stop_order: recalculatedStop.stop_order,
        arrival_time: recalculatedStop.arrival_time,
        departure_time: recalculatedStop.departure_time,
        travel_minutes_from_previous: Number(recalculatedStop.travel_minutes_from_previous || 0),
        updated_at: serverTimestamp()
      });
    });

    batch.update(doc(db, ITINERARY_COLLECTION, itinerary.document_id), {
      title,
      start_location_name: startPlace.name,
      start_latitude: startPlace.latitude,
      start_longitude: startPlace.longitude,
      end_location_name: endPlace.name,
      end_latitude: endPlace.latitude,
      end_longitude: endPlace.longitude,
      destination: endPlace.name,
      travel_date: travelDate,
      available_hours: availableHours,
      available_hours_unlimited: unlimitedHours,
      trip_days: tripDays,
      end_travel_date: endTravelDate,
      day_start_times: dayStartTimes,
      start_time: dayStartTimes["1"] || itinerary.start_time || "09:00",
      interest,
      interests,
      stop_count: stopDocs.length,
      travel_duration_minutes: timing.travelMinutes,
      total_duration_minutes: timing.totalMinutes,
      updated_at: serverTimestamp()
    });

    await batch.commit();
    selectedRoutePlaces = {};
    tripDetailsDirty = false;
    setRouteSaveMessage("Trip details saved.");
    if (changedDetails.length) {
      await addActivity("trip_details_updated", `${currentUserDisplayName()} updated ${changedDetails.join(", ")}`);
    }
  } catch (error) {
    itinerary = previousItinerary;
    console.error("Route details save failed:", error);
    setRouteSaveMessage("Could not save route details.", true);
  }
}

async function saveStopChanges(stopDocumentId, stopNumber, changes, confirmedFar = false, warningElement = null, saveButton = null) {
  if (!canEdit) return;

  const cleanName = String(changes.stop_name || "").trim();
  const existingStop = stopDocs.find(stop => stop.document_id === stopDocumentId);
  if (!cleanName || cleanName.toLowerCase() === "new stop") {
    openConfirmModal(
      "Stop name required",
      "Please enter the stop name before saving it.",
      null
    );
    return;
  }
  if (!hasValidStopCoordinates({ ...existingStop, ...changes })) {
    showStopValidationError(
      warningElement,
      "Please select a location from the suggestions before saving this stop."
    );
    return;
  }

  const nextMinutes = Number(changes.visit_duration_minutes || 0);
  const nextStops = stopDocs.map(stop => {
    return stop.document_id === stopDocumentId
      ? { ...stop, ...changes, visit_duration_minutes: nextMinutes }
      : stop;
  });
  const routeChanged = !stopsHaveSameRoute(stopDocs, nextStops);
  if (routeChanged) {
    setRouteSaveMessage(describeRouteCalculation(nextStops.length));
  }
  const timing = routeChanged
    ? await recalculateStopTimesWithOsrm(nextStops)
    : (() => {
      const localStops = recalculateStopTimesWithExistingTravel(nextStops);
      const travelMinutes = localStops.reduce((total, stop) => total + Number(stop.travel_minutes_from_previous || 0), 0)
        + getStoredFinalTravelMinutes(localStops);
      return {
        stops: localStops,
        travelMinutes,
        totalMinutes: getTotalRouteMinutes(localStops) + getStoredFinalTravelMinutes(localStops)
      };
    })();
  const farLegMessage = routeChanged ? getFarTravelLegMessage(timing) : "";
  const overageMessage = getRouteOverageMessage(timing.totalMinutes);
  if (overageMessage) {
    setRouteSaveMessage(overageMessage, true);
    return;
  }
  if (farLegMessage && !confirmedFar) {
    showFarStopConfirmation(warningElement, saveButton, farLegMessage);
    return;
  }
  clearFarStopConfirmation(warningElement, saveButton);
  const recalculatedStops = timing.stops;

  const batch = writeBatch(db);
  recalculatedStops.forEach(stop => {
    batch.update(doc(db, STOP_COLLECTION, stop.document_id), {
      stop_order: stop.stop_order,
      day_number: stop.day_number || 1,
      stop_name: stop.document_id === stopDocumentId ? cleanName : stop.stop_name,
      place_id: stop.place_id || "",
      address: stop.address || "",
      category: stop.category || "Custom Stop",
      rating: normaliseRatingForSave(stop.rating),
      latitude: Number(stop.latitude),
      longitude: Number(stop.longitude),
      arrival_time: stop.arrival_time,
      departure_time: stop.departure_time,
      visit_duration_minutes: Number(stop.visit_duration_minutes || 0),
      travel_minutes_from_previous: Number(stop.travel_minutes_from_previous || 0),
      updated_at: serverTimestamp()
    });
  });
  batch.update(doc(db, ITINERARY_COLLECTION, itinerary.document_id), {
    travel_duration_minutes: timing.travelMinutes,
    total_duration_minutes: timing.totalMinutes,
    updated_at: serverTimestamp()
  });

  await batch.commit();
  editingStopId = "";
  setRouteSaveMessage(
    routeChanged ? "Route timing updated." : "Visit time saved.",
    false
  );
  await addActivity("stop_updated", `${currentUserDisplayName()} updated stop ${stopNumber}`);
}

async function reorderStops(sourceId, targetId) {
  const sourceIndex = stopDocs.findIndex(item => item.document_id === sourceId);
  const targetIndex = stopDocs.findIndex(item => item.document_id === targetId);
  if (sourceIndex < 0 || targetIndex < 0) return;

  const reordered = [...stopDocs];
  const [moved] = reordered.splice(sourceIndex, 1);
  reordered.splice(targetIndex, 0, moved);
  setRouteSaveMessage(describeRouteCalculation(reordered.length));
  const timing = await recalculateStopTimesWithOsrm(reordered);
  const farLegMessage = getFarTravelLegMessage(timing, reordered);
  const overageMessage = getRouteOverageMessage(timing.totalMinutes);
  if (overageMessage) {
    setRouteSaveMessage(overageMessage, true);
    return;
  }
  const recalculatedStops = timing.stops;

  const batch = writeBatch(db);
  recalculatedStops.forEach((stop, index) => {
    batch.update(doc(db, STOP_COLLECTION, stop.document_id), {
      day_number: stop.day_number || 1,
      stop_order: index + 1,
      arrival_time: stop.arrival_time,
      departure_time: stop.departure_time,
      travel_minutes_from_previous: Number(stop.travel_minutes_from_previous || 0),
      updated_at: serverTimestamp()
    });
  });
  batch.update(doc(db, ITINERARY_COLLECTION, itinerary.document_id), {
    travel_duration_minutes: timing.travelMinutes,
    total_duration_minutes: timing.totalMinutes,
    updated_at: serverTimestamp()
  });
  await batch.commit();
  setRouteSaveMessage(farLegMessage || "Route timing updated.", Boolean(farLegMessage));
  await addActivity("stops_reordered", `${currentUserDisplayName()} reordered stops`);
}

async function deleteStop(stopDocumentId, stopName) {
  if (!canEdit) return;
  const remaining = stopDocs.filter(item => item.document_id !== stopDocumentId);
  setRouteSaveMessage(describeRouteCalculation(remaining.length));
  const timing = await recalculateStopTimesWithOsrm(remaining);
  const recalculatedStops = timing.stops;
  const batch = writeBatch(db);
  batch.delete(doc(db, STOP_COLLECTION, stopDocumentId));
  recalculatedStops.forEach((stop, index) => {
    batch.update(doc(db, STOP_COLLECTION, stop.document_id), {
      day_number: stop.day_number || 1,
      stop_order: index + 1,
      arrival_time: stop.arrival_time,
      departure_time: stop.departure_time,
      travel_minutes_from_previous: Number(stop.travel_minutes_from_previous || 0),
      updated_at: serverTimestamp()
    });
  });
  batch.update(doc(db, ITINERARY_COLLECTION, itinerary.document_id), {
    stop_count: remaining.length,
    travel_duration_minutes: timing.travelMinutes,
    total_duration_minutes: timing.totalMinutes,
    updated_at: serverTimestamp()
  });
  await batch.commit();
  setRouteSaveMessage("Route timing updated.");
  await addActivity("stop_deleted", `${currentUserDisplayName()} deleted ${stopName}`);
}

async function addStop() {
  if (!canEdit || !itinerary) return;
  const currentTotalMinutes = getTotalRouteMinutesWithFinalLeg(recalculateStopTimesWithExistingTravel(stopDocs));
  const overageMessage = getRouteOverageMessage(currentTotalMinutes);
  if (overageMessage) {
    setRouteSaveMessage(overageMessage, true);
    updateAddStopButtonState();
    return;
  }
  if (stopDocs.length >= MAX_EDIT_STOPS) {
    setRouteSaveMessage(`Cannot add more than ${MAX_EDIT_STOPS} stops.`, true);
    updateAddStopButtonState();
    return;
  }
  if (draftStop) {
    editingStopId = "__draft_stop__";
    renderStops();
    scrollToEditingStop();
    return;
  }
  const lastStop = stopDocs.length ? stopDocs[stopDocs.length - 1] : null;
  draftStop = {
    document_id: "__draft_stop__",
    stop_order: stopDocs.length + 1,
    day_number: normaliseDayNumber(lastStop?.day_number || lastStop?.day || 1),
    stop_name: "",
    category: "",
    rating: 0,
    latitude: null,
    longitude: null,
    arrival_time: "",
    departure_time: "",
    visit_duration_minutes: 60,
    travel_minutes_from_previous: 0
  };
  editingStopId = "__draft_stop__";
  renderStops();
  scrollToEditingStop();
}

async function createStopFromDraft(stopNumber, changes, confirmedFar = false, warningElement = null, saveButton = null) {
  if (!canEdit || !itinerary || !draftStop) return;
  if (stopDocs.length >= MAX_EDIT_STOPS) {
    setRouteSaveMessage(`Cannot add more than ${MAX_EDIT_STOPS} stops.`, true);
    draftStop = null;
    editingStopId = "";
    renderStops();
    return;
  }
  const cleanName = String(changes.stop_name || "").trim();
  if (!cleanName || cleanName.toLowerCase() === "new stop") {
    openConfirmModal(
      "Stop name required",
      "Please enter the stop name before saving it.",
      null
    );
    return;
  }
  if (!hasValidStopCoordinates(changes)) {
    showStopValidationError(
      warningElement,
      "Please select a location from the suggestions before saving this stop."
    );
    return;
  }

  const stopRef = doc(collection(db, STOP_COLLECTION));
  const nextOrder = stopDocs.length + 1;
  const newStop = {
    document_id: stopRef.id,
    stop_order: nextOrder,
    day_number: normaliseDayNumber(changes.day_number || 1),
    stop_name: cleanName,
    place_id: changes.place_id || "",
    address: changes.address || "",
    category: changes.category || "Custom Stop",
    rating: normaliseRatingForSave(changes.rating),
    latitude: Number(changes.latitude),
    longitude: Number(changes.longitude),
    visit_duration_minutes: Number(changes.visit_duration_minutes || 0),
    travel_minutes_from_previous: 0
  };
  setRouteSaveMessage(describeRouteCalculation(stopDocs.length + 1));
  const timing = await recalculateStopTimesWithOsrm([...stopDocs, newStop]);
  const farLegMessage = getFarTravelLegMessage(timing);
  const overageMessage = getRouteOverageMessage(timing.totalMinutes);
  if (overageMessage) {
    setRouteSaveMessage(overageMessage, true);
    return;
  }
  if (farLegMessage && !confirmedFar) {
    showFarStopConfirmation(warningElement, saveButton, farLegMessage);
    setRouteSaveMessage("");
    return;
  }
  clearFarStopConfirmation(warningElement, saveButton);
  const recalculatedStops = timing.stops;
  const calculatedNewStop = recalculatedStops[recalculatedStops.length - 1];
  await setDoc(stopRef, {
    stop_id: stopRef.id,
    itinerary_id: activeItineraryId,
    stop_order: nextOrder,
    day_number: calculatedNewStop.day_number || normaliseDayNumber(changes.day_number || 1),
    stop_name: cleanName,
    place_id: changes.place_id || "",
    address: changes.address || "",
    category: changes.category || "Custom Stop",
    rating: normaliseRatingForSave(changes.rating),
    latitude: Number(changes.latitude),
    longitude: Number(changes.longitude),
    arrival_time: calculatedNewStop.arrival_time,
    departure_time: calculatedNewStop.departure_time,
    visit_duration_minutes: Number(calculatedNewStop.visit_duration_minutes || 0),
    travel_minutes_from_previous: Number(calculatedNewStop.travel_minutes_from_previous || 0),
    created_at: serverTimestamp(),
    updated_at: serverTimestamp()
  });

  await updateDoc(doc(db, ITINERARY_COLLECTION, itinerary.document_id), {
    stop_count: nextOrder,
    travel_duration_minutes: timing.travelMinutes,
    total_duration_minutes: timing.totalMinutes,
    updated_at: serverTimestamp()
  });
  draftStop = null;
  editingStopId = "";
  setRouteSaveMessage("Route timing updated.");
  await addActivity("stop_added", `${currentUserDisplayName()} added ${cleanName}`);
}

function renderCollaborators() {
  if (!collaboratorList) return;
  const visibleCollaborators = dedupeCollaborators(collaboratorDocs);

  if (peopleCount) {
    const acceptedCount = visibleCollaborators.filter(item => item.status === "accepted").length || 1;
    peopleCount.textContent = `${acceptedCount} ${acceptedCount === 1 ? "person" : "people"}`;
  }

  const sorted = [...visibleCollaborators].sort((a, b) => {
    if (a.role === "owner") return -1;
    if (b.role === "owner") return 1;
    return String(a.email || "").localeCompare(String(b.email || ""));
  });

  collaboratorList.innerHTML = "";
  sorted.forEach(collaborator => {
    const row = document.createElement("div");
    row.className = "collaborator-row";
    const name = displayNameFromCollaborator(collaborator);
    const canChangeRole = isOwner && collaborator.role !== "owner" && collaborator.status === "accepted";
    const canRemove = isOwner && collaborator.role !== "owner";
    row.innerHTML = `
      ${avatarHtmlForUser(collaborator.user_id, name, "collaborator-avatar")}
      <div class="collaborator-info">
        <div class="collaborator-name">${escapeHtml(name)}</div>
        <div class="collaborator-email">${escapeHtml(collaborator.email || "")}</div>
      </div>
      <div class="collaborator-actions">
        ${collaborator.status === "pending" || collaborator.status === "pending_registration"
          ? `<span class="authority-pill pending-pill">Pending</span>`
          : canChangeRole
            ? `<select class="role-select js-role-select"><option value="viewer">Viewer</option><option value="editor">Editor</option></select>`
            : `<span class="authority-pill owner-pill">${escapeHtml(collaborator.role || "viewer")}</span>`}
        ${canRemove ? `<button type="button" class="icon-trash-btn collaborator-remove-btn js-remove-collaborator" aria-label="Remove collaborator" title="Remove collaborator">
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M3 6h18"></path>
            <path d="M8 6V4h8v2"></path>
            <path d="M6 6l1 15h10l1-15"></path>
            <path d="M10 10v7"></path>
            <path d="M14 10v7"></path>
          </svg>
        </button>` : ""}
      </div>
    `;

    const roleSelect = row.querySelector(".js-role-select");
    if (roleSelect) {
      roleSelect.value = collaborator.role || "viewer";
      roleSelect.addEventListener("change", function () {
        updateCollaboratorRole(collaborator, roleSelect.value).catch(error => {
          console.error("Failed to update collaborator role:", error);
          roleSelect.value = collaborator.role || "viewer";
          setInviteMessage("Could not update authority. Please try again.", true);
        });
      });
    }

    row.querySelector(".js-remove-collaborator")?.addEventListener("click", function () {
      const collaboratorName = collaborator.email || name;
      openConfirmModal(
        "Remove collaborator?",
        `Remove ${collaboratorName} from this itinerary? This action cannot be undone.`,
        () => removeCollaborator(collaborator.document_id, collaboratorName).catch(console.error)
      );
    });

    collaboratorList.appendChild(row);
  });
}

async function updateCollaboratorRole(collaborator, role) {
  if (!isOwner) return;
  const targetDocumentId = expectedCollaboratorDocumentId(collaborator) || collaborator.document_id;
  const payload = {
    ...collaborator,
    collaborator_id: targetDocumentId,
    role,
    updated_at: serverTimestamp()
  };
  delete payload.document_id;

  if (targetDocumentId !== collaborator.document_id) {
    await setDoc(doc(db, COLLABORATOR_COLLECTION, targetDocumentId), payload, { merge: true });
    deleteDoc(doc(db, COLLABORATOR_COLLECTION, collaborator.document_id)).catch(error => {
      console.warn("Could not delete old collaborator record:", error);
    });
  } else {
    await updateDoc(doc(db, COLLABORATOR_COLLECTION, targetDocumentId), {
      role,
      updated_at: serverTimestamp()
    });
  }

  setInviteMessage("");
  await addActivity("role_changed", `${currentUserDisplayName()} changed ${collaborator.email || "a collaborator"} to ${role}`);
}

async function removeCollaborator(collaboratorDocumentId, email) {
  if (!isOwner) return;
  await deleteDoc(doc(db, COLLABORATOR_COLLECTION, collaboratorDocumentId));
  await addActivity("collaborator_removed", `${currentUserDisplayName()} removed ${email}`);
}

async function findRegisteredUserByEmail(email) {
  const userQuery = query(collection(db, USER_COLLECTION), where("email", "==", email), limit(1));
  const snapshot = await getDocs(userQuery);
  if (snapshot.empty) return null;
  return { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
}

async function inviteCollaborator(email) {
  if (!canEdit || !itinerary) return;
  const existing = collaboratorDocs.find(item => normaliseEmail(item.email) === email);
  if (existing) {
    setInviteMessage("This person is already invited or added.", true);
    return;
  }

  const existingQuery = query(
    collection(db, COLLABORATOR_COLLECTION),
    where("itinerary_id", "==", activeItineraryId),
    where("email", "==", email)
  );
  const existingSnapshot = await getDocs(existingQuery);

  if (!existingSnapshot.empty) {
    setInviteMessage("This person is already invited or added.", true);
    return;
  }

  const registeredUser = await findRegisteredUserByEmail(email);
  if (registeredUser?.id) {
    userProfileCache.set(registeredUser.id, registeredUser);
  }
  const collaboratorId = registeredUser
  ? collaboratorDocumentId(
      itinerary.document_id,
      registeredUser.id
    )
  : pendingInviteDocumentId(
      itinerary.document_id,
      email
    );

  const collaboratorRef = doc(
    db,
    COLLABORATOR_COLLECTION,
    collaboratorId
  );

  const inviterName =
    currentUserDisplayName();
  const baseInvite = {
    collaborator_id: collaboratorRef.id,
    itinerary_id: activeItineraryId,
    itinerary_document_id: itinerary.document_id,
    owner_id: itinerary.user_id,
    owner_email: normaliseEmail(currentUser.email),
    invited_by: currentUser.uid,
    invited_by_name: inviterName,
    email,
    display_name: registeredUser?.displayName || registeredUser?.display_name || registeredUser?.name || "",
    role: "viewer",
    status: registeredUser ? "pending" : "pending_registration",
    created_at: serverTimestamp(),
    updated_at: serverTimestamp()
  };

  await setDoc(collaboratorRef, {
    ...baseInvite,
    user_id: registeredUser ? registeredUser.id : ""
  });

  const notificationRef = doc(
    db,
    NOTIFICATION_COLLECTION,
    notificationDocumentId(itinerary.document_id, "invite_sent", email)
  );
  await setDoc(notificationRef, {
    notification_id: notificationRef.id,
    itinerary_id: activeItineraryId,
    itinerary_document_id: itinerary.document_id,
    actor_id: currentUser.uid,
    actor_name: inviterName,
    type: "invite_sent",
    message: `${inviterName} invited ${email}`,
    created_at: serverTimestamp()
  }, { merge: true });

  if (registeredUser) {
    setInviteMessage("Invitation request sent. It will show as pending until accepted.");
    if (inviteOptions) inviteOptions.classList.remove("show");
  } else {
    const joinUrl = `${window.location.origin}/saved-itineraries/${encodeURIComponent(itinerary.document_id)}/edit?invite=${encodeURIComponent(collaboratorRef.id)}`;
    pendingInviteLink = joinUrl;
    pendingInviteEmail = email;
    setInviteMessage("This user is not registered yet. Send or copy the joining link.");
    if (inviteOptions) inviteOptions.classList.add("show");
  }

  if (inviteEmailInput) inviteEmailInput.value = "";
}

function renderComments(comments) {
  if (!commentsList) return;
  commentsList.classList.toggle("is-scrollable", comments.length > 4);
  if (!comments.length) {
    commentsList.innerHTML = `<div class="empty-soft">No comments yet.</div>`;
    return;
  }

  commentsList.innerHTML = "";

  comments.forEach(comment => {
    const isOwnComment = currentUser && comment.author_id === currentUser.uid;
    const authorName = displayNameFromUserSnapshot(comment, comment.author_name, comment.author_email);
    const isEditing = editingCommentId === comment.document_id;
    const isNew = hasCommentsViewedState &&
      !isOwnComment &&
      timestampMillis(comment.created_at) > lastCommentsViewedAt;
    if (isNew) rememberTemporaryHighlight(temporaryCommentHighlights, comment.document_id);
    const showNewHighlight = isNew || hasTemporaryHighlight(temporaryCommentHighlights, comment.document_id);
    const row = document.createElement("div");
    row.className = `comment-row ${showNewHighlight ? "is-new" : ""}`;
    row.innerHTML = `
      ${avatarHtmlForUser(comment.author_id, authorName, "comment-avatar")}
      <div class="comment-body">
        <div class="comment-name">${escapeHtml(authorName)}</div>
        <div class="comment-time">${escapeHtml(formatRelativeTime(comment.created_at))}</div>
        ${isEditing
          ? `<textarea class="comment-edit-input js-comment-edit-input" maxlength="500">${escapeHtml(comment.text || "")}</textarea>`
          : `<div class="comment-text">${escapeHtml(comment.text || "")}</div>`}
      </div>
      ${isOwnComment || isOwner
        ? `<div class="comment-actions">
            ${isOwnComment && isEditing
              ? `<button type="button" class="btn btn-primary btn-sm js-save-comment">Save</button><button type="button" class="btn btn-secondary btn-sm js-cancel-comment">Cancel</button>`
              : `${isOwnComment ? `<button type="button" class="btn btn-secondary btn-sm js-edit-comment">Edit</button>` : ""}
                 <button type="button" class="icon-trash-btn js-delete-comment" aria-label="Delete comment" title="Delete comment">
                   <svg viewBox="0 0 24 24" aria-hidden="true">
                     <path d="M3 6h18"></path>
                     <path d="M8 6V4h8v2"></path>
                     <path d="M6 6l1 15h10l1-15"></path>
                     <path d="M10 10v7"></path>
                     <path d="M14 10v7"></path>
                   </svg>
                 </button>`}
          </div>`
        : ""}
    `;

    row.querySelector(".js-edit-comment")?.addEventListener("click", function () {
      editingCommentId = comment.document_id;
      renderComments(comments);
    });

    row.querySelector(".js-cancel-comment")?.addEventListener("click", function () {
      editingCommentId = "";
      renderComments(comments);
    });

    row.querySelector(".js-save-comment")?.addEventListener("click", function () {
      const input = row.querySelector(".js-comment-edit-input");
      updateComment(comment.document_id, input?.value || "").catch(console.error);
    });

    row.querySelector(".js-delete-comment")?.addEventListener("click", function () {
      openConfirmModal(
        "Delete comment?",
        "Delete this comment from the itinerary? This action cannot be undone.",
        () => deleteComment(comment.document_id).catch(console.error)
      );
    });

    commentsList.appendChild(row);
  });
}

function markCommentsViewedSoon(comments) {
  if (!ownCollaboratorDocumentId || !comments.length || !hasCommentsViewedState) return;
  const hasUnseenComment = comments.some(comment => {
    return comment.author_id !== currentUser?.uid &&
      timestampMillis(comment.created_at) > lastCommentsViewedAt;
  });

  if (!hasUnseenComment) return;

  clearTimeout(commentsSeenTimer);
  commentsSeenTimer = setTimeout(function () {
    updateDoc(doc(db, COLLABORATOR_COLLECTION, ownCollaboratorDocumentId), {
      last_comments_viewed_at: serverTimestamp()
    }).catch(console.error);
  }, 2000);
}

async function addComment(text) {
  const trimmed = text.trim();
  if (!itinerary || !currentUser) return;
  if (!trimmed) {
    setCommentMessage("Comment cannot be empty.", true);
    return false;
  }
  if (trimmed.length > 500) {
    setCommentMessage("Comment cannot exceed 500 characters.", true);
    return false;
  }
  const validation = validateContent(trimmed);
  if (!validation.isValid) {
    setCommentMessage(validation.message, true);
    return false;
  }
  setCommentMessage("");
  const authorName = currentUserDisplayName();
  await addDoc(collection(db, COMMENT_COLLECTION), {
    itinerary_id: activeItineraryId,
    itinerary_document_id: itinerary.document_id,
    author_id: currentUser.uid,
    author_name: authorName,
    author_email: normaliseEmail(currentUser.email),
    text: trimmed,
    created_at: serverTimestamp()
  });
  await addActivity("comment_added", `${authorName} added a comment`);
  return true;
}

async function updateComment(commentDocumentId, text) {
  const trimmed = text.trim();
  if (!currentUser) return;
  if (!trimmed) {
    setCommentMessage("Comment cannot be empty.", true);
    return;
  }
  if (trimmed.length > 500) {
    setCommentMessage("Comment cannot exceed 500 characters.", true);
    return;
  }
  const validation = validateContent(trimmed);
  if (!validation.isValid) {
    setCommentMessage(validation.message, true);
    return;
  }
  setCommentMessage("");
  await updateDoc(doc(db, COMMENT_COLLECTION, commentDocumentId), {
    text: trimmed,
    edited_at: serverTimestamp()
  });
  editingCommentId = "";
  await addActivity("comment_updated", `${currentUserDisplayName()} edited a comment`);
}

async function deleteComment(commentDocumentId) {
  if (!currentUser || !commentDocumentId) return;
  await deleteDoc(doc(db, COMMENT_COLLECTION, commentDocumentId));
  await addActivity("comment_deleted", `${currentUserDisplayName()} deleted a comment`);
}

function renderActivities(activities) {
  if (!activityList) return;
  if (!activities.length) {
    activityList.innerHTML = `<div class="empty-soft">No activity yet.</div>`;
    return;
  }

  activityList.innerHTML = activities.map((activity, index) => {
    const isOwnActivity = currentUser && activity.actor_id === currentUser.uid;
    const isNew = !isOwnActivity && timestampMillis(activity.created_at) > lastActivityViewedAt;
    if (isNew) rememberTemporaryHighlight(temporaryActivityHighlights, activity.document_id);
    const showNewHighlight = isNew || hasTemporaryHighlight(temporaryActivityHighlights, activity.document_id);
    return `
      <div class="activity-row ${showNewHighlight ? "is-new" : ""}">
        <div class="activity-number">${index + 1}</div>
        <div class="activity-body">
          <div class="activity-text">${escapeHtml(applyCurrentProfileToMessage(activity))}</div>
          <div class="activity-time">${escapeHtml(formatRelativeTime(activity.created_at))}</div>
        </div>
      </div>
    `;
  }).join("");
}

function sortStopsForEditor(stops) {
  return [...stops].sort((a, b) => {
    const dayDifference = Number(a.day_number || 1) - Number(b.day_number || 1);
    if (dayDifference) return dayDifference;
    return Number(a.stop_order || 0) - Number(b.stop_order || 0);
  });
}

function subscribeToData() {
  unsubscribeFns.forEach(unsubscribe => unsubscribe());
  unsubscribeFns = [];

  const itineraryRef = doc(db, ITINERARY_COLLECTION, itineraryDocumentId);
  unsubscribeFns.push(onSnapshot(itineraryRef, snapshot => {
    if (!snapshot.exists()) {
      showError();
      return;
    }
    itinerary = {
      document_id: snapshot.id,
      itinerary_id: snapshot.data().itinerary_id || snapshot.id,
      ...snapshot.data()
    };
    activeItineraryId = itinerary.itinerary_id || itinerary.document_id;
    isOwner = itinerary.user_id === currentUser.uid;
    renderItinerary();
    showContent();
  }));

  const stopSnapshotsByKey = new Map();
  const renderMergedStops = function () {
    const mergedStops = new Map();
    stopSnapshotsByKey.forEach(items => {
      items.forEach(stop => mergedStops.set(stop.document_id, stop));
    });
    stopDocs = sortStopsForEditor(Array.from(mergedStops.values()));
    renderItinerary();
    renderStops();
  };
  const stopQueryIds = Array.from(new Set([
    activeItineraryId,
    itineraryDocumentId,
    itinerary?.document_id
  ].filter(Boolean)));

  stopQueryIds.forEach(stopQueryId => {
    const stopsQuery = query(collection(db, STOP_COLLECTION), where("itinerary_id", "==", stopQueryId));
    unsubscribeFns.push(onSnapshot(stopsQuery, snapshot => {
      stopSnapshotsByKey.set(
        stopQueryId,
        snapshot.docs.map(item => ({ document_id: item.id, ...item.data() }))
      );
      renderMergedStops();
    }));
  });

  const collaboratorQuery = query(collection(db, COLLABORATOR_COLLECTION), where("itinerary_id", "==", activeItineraryId));
  unsubscribeFns.push(onSnapshot(collaboratorQuery, async snapshot => {
    collaboratorDocs = dedupeCollaborators(snapshot.docs.map(item => ({ document_id: item.id, ...item.data() })));
    await loadUserProfilesForIds(collaboratorDocs.map(item => item.user_id));
    const ownCollaborator = collaboratorDocs.find(item => item.user_id === currentUser.uid);
    ownCollaboratorDocumentId = ownCollaborator?.document_id || "";
    lastActivityViewedAt = timestampMillis(ownCollaborator?.last_activity_viewed_at);
    hasCommentsViewedState = Boolean(
      ownCollaborator &&
      Object.prototype.hasOwnProperty.call(ownCollaborator, "last_comments_viewed_at")
    );
    lastCommentsViewedAt = hasCommentsViewedState
      ? timestampMillis(ownCollaborator?.last_comments_viewed_at)
      : Date.now();
    setEditingState();
    ensureOwnerCollaborator().catch(console.error);
    if (ownCollaboratorDocumentId && !hasCommentsViewedState) {
      updateDoc(doc(db, COLLABORATOR_COLLECTION, ownCollaboratorDocumentId), {
        last_comments_viewed_at: serverTimestamp()
      }).catch(console.error);
    }
    renderStops();
    renderCollaborators();
    markCommentsViewedSoon(latestCommentDocs);
  }));

  const commentsQuery = query(collection(db, COMMENT_COLLECTION), where("itinerary_id", "==", activeItineraryId));
  unsubscribeFns.push(onSnapshot(commentsQuery, async snapshot => {
    latestCommentDocs = sortByCreatedDesc(snapshot.docs.map(item => ({ document_id: item.id, ...item.data() })));
    await loadUserProfilesForIds(latestCommentDocs.map(item => item.author_id));
    renderComments(latestCommentDocs.slice(0, 20));
    markCommentsViewedSoon(latestCommentDocs);
  }));

  subscribeToActivities();
}

function subscribeToActivities() {
  const activityQuery = allActivityMode
    ? query(collection(db, NOTIFICATION_COLLECTION), where("itinerary_id", "==", activeItineraryId))
    : query(collection(db, NOTIFICATION_COLLECTION), where("itinerary_id", "==", activeItineraryId));

  const activityUnsubscribe = onSnapshot(activityQuery, async snapshot => {
    latestActivityDocs = sortByCreatedDesc(dedupeNotifications(snapshot.docs.map(item => ({ document_id: item.id, ...item.data() }))));
    await loadUserProfilesForIds(latestActivityDocs.map(item => item.actor_id));
    renderActivities(allActivityMode ? latestActivityDocs : latestActivityDocs.slice(0, 5));
  });

  unsubscribeFns.push(activityUnsubscribe);
}

async function loadInitial(user) {
  currentUser = user;
  await loadUserProfilesForIds([user.uid]);
  const itinerarySnap = await getDoc(doc(db, ITINERARY_COLLECTION, itineraryDocumentId));
  if (!itinerarySnap.exists()) {
    showError();
    return;
  }

  const data = itinerarySnap.data();
  activeItineraryId = data.itinerary_id || itineraryDocumentId;
  const owner = data.user_id === user.uid;

  if (!owner) {
    const accessQuery = query(
      collection(db, COLLABORATOR_COLLECTION),
      where("itinerary_id", "==", activeItineraryId),
      where("user_id", "==", user.uid),
      where("status", "==", "accepted")
    );
    const accessSnapshot = await getDocs(accessQuery);
    if (accessSnapshot.empty) {
      showError();
      return;
    }
  }

  subscribeToData();
}

[
  titleInput,
  routeStartInput,
  routeEndInput,
  routeHoursInput
].forEach(element => {
  element?.addEventListener("input", markTripDetailsDirty);
});

routeInterestInput?.querySelectorAll('input[name="route_interests"]').forEach(input => {
  input.addEventListener("change", markTripDetailsDirty);
});

dayStartGrid?.addEventListener("input", function (event) {
  if (event.target.closest(".js-day-start-time")) {
    markTripDetailsDirty();
  }
});

dateInput?.addEventListener("change", function () {
  if (!canEdit || !itinerary) return;
  markTripDetailsDirty();
  if (dateRangeText) {
    dateRangeText.textContent = formatTripDateRange();
  }
});

daysInput?.addEventListener("change", function () {
  if (!canEdit || !itinerary) return;
  markTripDetailsDirty();
  const nextDays = Math.min(30, Math.max(1, Math.round(Number(daysInput.value || 1))));
  const previousTimes = getDayStartTimesFromInputs(nextDays);
  const dayStartTimes = {};

  for (let dayNumber = 1; dayNumber <= nextDays; dayNumber += 1) {
    dayStartTimes[String(dayNumber)] = previousTimes[String(dayNumber)] || itinerary.start_time || "09:00";
  }

  daysInput.value = String(nextDays);
  renderDayStartControls(dayStartTimes);
  if (dateRangeText) {
    dateRangeText.textContent = formatTripDateRange();
  }
});

routeHoursUnlimitedInput?.addEventListener("change", function () {
  markTripDetailsDirty();
  if (routeHoursInput) {
    routeHoursInput.disabled = !canEdit || routeHoursUnlimitedInput.checked;
  }
  updateAddStopButtonState();
});

setupRoutePlaceAutocomplete(routeStartInput, routeStartSuggestions, "start");
setupRoutePlaceAutocomplete(routeEndInput, routeEndSuggestions, "end");

saveRouteDetailsButton?.addEventListener("click", function (event) {
  runBusyAction(
    "save-route-details",
    event.currentTarget,
    "Saving...",
    saveRouteDetails
  ).catch(error => {
    console.error("Route details save failed:", error);
    setRouteSaveMessage("Could not save route details.", true);
  });
});

addStopButton?.addEventListener("click", function (event) {
  runBusyAction(
    "add-stop-draft",
    event.currentTarget,
    "Adding...",
    addStop
  ).catch(console.error);
});

inviteEmailInput?.addEventListener("input", function () {
  clearTimeout(inviteSearchTimer);
  const value = inviteEmailInput.value;
  inviteSearchTimer = setTimeout(function () {
    searchRegisteredUsers(value);
  }, 250);
});

document.addEventListener("click", function (event) {
  if (!event.target.closest(".invite-search-wrap")) {
    clearInviteSuggestions();
  }
});

inviteForm?.addEventListener("submit", function (event) {
  event.preventDefault();
  const submitButton = inviteForm.querySelector('button[type="submit"]');
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

  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "Inviting...";
  }

  inviteCollaborator(email)
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

sendJoinEmailButton?.addEventListener("click", function () {
  const email = pendingInviteEmail || normaliseEmail(inviteEmailInput?.value);
  const tripTitle = itinerary?.title || titleInput?.value || "PandaJourney trip";
  const tripDate = itinerary?.travel_date ? formatDate(itinerary.travel_date) : "a planned travel date";
  const inviterName = currentUserDisplayName();
  const subject = encodeURIComponent(`Invitation: ${tripTitle}`);
  const body = encodeURIComponent(
    `Hi,\n\n${inviterName} invited you to collaborate on a PandaJourney itinerary.\n\n` +
    `Itinerary: ${tripTitle}\n` +
    `Travel date: ${tripDate}\n` +
    `Default access: Viewer\n\n` +
    `Open this link to join or create your account:\n${pendingInviteLink}\n\n` +
    `After signing in with this email address, you will see the invitation request in PandaJourney.\n\n` +
    `Thank you,\nPandaJourney`
  );
  const gmailUrl = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}&su=${subject}&body=${body}`;
  window.open(gmailUrl, "_blank", "noopener,noreferrer");
});

copyJoinLinkButton?.addEventListener("click", async function () {
  if (!pendingInviteLink) return;
  await navigator.clipboard.writeText(pendingInviteLink);
  setInviteMessage("Joining link copied.");
});

confirmCancelButton?.addEventListener("click", closeConfirmModal);

confirmModal?.addEventListener("click", function (event) {
  if (event.target === confirmModal) closeConfirmModal();
});

confirmDeleteButton?.addEventListener("click", function (event) {
  const action = pendingConfirmAction;
  closeConfirmModal();
  if (typeof action === "function") {
    runBusyAction(
      "confirm-action",
      event.currentTarget,
      "Deleting...",
      action
    ).catch(console.error);
  }
});

commentForm?.addEventListener("submit", function (event) {
  event.preventDefault();
  const submitButton = commentForm.querySelector('button[type="submit"]');
  const text = commentInput?.value || "";
  if (!text.trim()) {
    setCommentMessage("Comment cannot be empty.", true);
    return;
  }
  runBusyAction(
    "add-comment",
    submitButton,
    "Sending...",
    () => addComment(text)
  )
    .then(commentWasAdded => {
      if (commentWasAdded && commentInput) commentInput.value = "";
    })
    .catch(console.error);
});

viewAllActivityButton?.addEventListener("click", async function () {
  allActivityMode = !allActivityMode;
  viewAllActivityButton.textContent = allActivityMode ? "Show recent activity" : "View all activity";
  if (currentUser && itinerary) {
    const ownCollaborator = collaboratorDocs.find(item => item.user_id === currentUser.uid);
    if (ownCollaborator?.document_id) {
      await updateDoc(doc(db, COLLABORATOR_COLLECTION, ownCollaborator.document_id), {
        last_activity_viewed_at: serverTimestamp()
      });
    }
  }
  subscribeToData();
});

onAuthStateChanged(auth, function (user) {
  if (!user) {
    showError();
    return;
  }

  loadInitial(user).catch(error => {
    console.error("Failed to load editor:", error);
    showError();
  });
});
