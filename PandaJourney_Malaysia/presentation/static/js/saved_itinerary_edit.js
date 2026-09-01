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
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

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
const routeStartInput = document.getElementById("route-start-input");
const routeEndInput = document.getElementById("route-end-input");
const routeStartSuggestions = document.getElementById("route-start-suggestions");
const routeEndSuggestions = document.getElementById("route-end-suggestions");
const routeHoursInput = document.getElementById("route-hours-input");
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
let activeItineraryId = itineraryDocumentId;
let collaboratorDocs = [];
let stopDocs = [];
let currentRole = "viewer";
let canEdit = false;
let isOwner = false;
let allActivityMode = false;
let lastActivityViewedAt = 0;
let lastCommentsViewedAt = 0;
let ownCollaboratorDocumentId = "";
let hasCommentsViewedState = false;
let pendingInviteLink = "";
let pendingInviteEmail = "";
let unsubscribeFns = [];
let titleSaveTimer = null;
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
let commentsSeenTimer = null;
let highlightRefreshTimer = null;
let latestCommentDocs = [];
let latestActivityDocs = [];
const NEW_HIGHLIGHT_MS = 60 * 1000;
const temporaryActivityHighlights = new Map();
const temporaryCommentHighlights = new Map();

function normaliseRatingForSave(value) {
  if (value === "Not available") return "Not available";
  const numberValue = Number(value || 0);
  return Number.isFinite(numberValue) && numberValue > 0
    ? numberValue
    : "Not available";
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

function displayNameFromCollaborator(collaborator) {
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

function formatMinutesAsDuration(minutes) {
  const totalMinutes = Number(minutes || 0);
  if (!Number.isFinite(totalMinutes) || totalMinutes <= 0) return "Estimated";

  const hours = Math.floor(totalMinutes / 60);
  const remainder = totalMinutes % 60;

  if (!hours) return `${remainder} mins`;
  if (!remainder) return `${hours} hr${hours === 1 ? "" : "s"}`;
  return `${hours} hr${hours === 1 ? "" : "s"} ${remainder} mins`;
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
  return Number.isFinite(Number(stop.latitude)) && Number.isFinite(Number(stop.longitude));
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
  let cursor = parseClockMinutes(itinerary?.start_time || "09:00");
  let previousPoint = {
    latitude: itinerary?.start_latitude,
    longitude: itinerary?.start_longitude
  };

  return stops.map((stop, index) => {
    const visitMinutes = Math.max(0, Number(stop.visit_duration_minutes || 0));
    const travelMinutes = estimateTravelMinutes(previousPoint, stop);
    const arrivalMinutes = cursor + travelMinutes;
    const departureMinutes = arrivalMinutes + visitMinutes;
    previousPoint = stop;
    cursor = departureMinutes;

    return {
      ...stop,
      stop_order: index + 1,
      travel_minutes_from_previous: travelMinutes,
      arrival_time: formatClockMinutes(arrivalMinutes),
      departure_time: formatClockMinutes(departureMinutes),
      visit_duration_minutes: visitMinutes
    };
  });
}

function recalculateStopTimesWithExistingTravel(stops) {
  let cursor = parseClockMinutes(itinerary?.start_time || "09:00");

  return stops.map((stop, index) => {
    const visitMinutes = Math.max(0, Number(stop.visit_duration_minutes || 0));
    const travelMinutes = Math.max(0, Number(stop.travel_minutes_from_previous || 0));
    const arrivalMinutes = cursor + travelMinutes;
    const departureMinutes = arrivalMinutes + visitMinutes;
    cursor = departureMinutes;

    return {
      ...stop,
      stop_order: index + 1,
      arrival_time: formatClockMinutes(arrivalMinutes),
      departure_time: formatClockMinutes(departureMinutes),
      visit_duration_minutes: visitMinutes,
      travel_minutes_from_previous: travelMinutes
    };
  });
}

function getItineraryPoint(prefix) {
  const latitude = Number(itinerary?.[`${prefix}_latitude`]);
  const longitude = Number(itinerary?.[`${prefix}_longitude`]);

  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
    return null;
  }

  return { latitude, longitude };
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

  let cursor = parseClockMinutes(itinerary?.start_time || "09:00");
  let previousPoint = startPoint || {
    latitude: itinerary?.start_latitude,
    longitude: itinerary?.start_longitude
  };
  let totalTravelMinutes = 0;

  const recalculatedStops = stops.map((stop, index) => {
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
  const parts = text.split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return `${parts[0][0]}${parts[1][0]}`.toUpperCase();
  return text.slice(0, 2).toUpperCase();
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
    await callback();
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

function stopsHaveSameRoute(previousStops, nextStops) {
  if (previousStops.length !== nextStops.length) return false;

  return previousStops.every((stop, index) => {
    const nextStop = nextStops[index];
    if (!nextStop) return false;
    return (
      stop.document_id === nextStop.document_id
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
    routeStartInput,
    routeEndInput,
    routeHoursInput,
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
  addStopButton.disabled = !canEdit || Boolean(draftStop) || Boolean(busyAction) || isAtStopLimit;
  addStopButton.hidden = isAtStopLimit;
  if (isAtStopLimit) {
    addStopButton.textContent = `Cannot add more than ${MAX_EDIT_STOPS} stops`;
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
  if (!itinerary || !currentUser || !isOwner) return;
  const alreadyExists = collaboratorDocs.some(item => item.role === "owner" && item.user_id === currentUser.uid);
  if (alreadyExists) return;

  const ownerRef = doc(collection(db, COLLABORATOR_COLLECTION));
  await setDoc(ownerRef, {
    collaborator_id: ownerRef.id,
    itinerary_id: activeItineraryId,
    itinerary_document_id: itinerary.document_id,
    user_id: currentUser.uid,
    email: normaliseEmail(currentUser.email),
    display_name: currentUser.displayName || currentUser.email || "Owner",
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
  await addDoc(collection(db, NOTIFICATION_COLLECTION), {
    itinerary_id: activeItineraryId,
    itinerary_document_id: itinerary.document_id,
    actor_id: currentUser.uid,
    actor_name: currentUser.displayName || currentUser.email || "A collaborator",
    type,
    message,
    created_at: serverTimestamp()
  });
}

function renderItinerary() {
  if (!itinerary) return;
  if (titleInput && titleInput.value !== (itinerary.title || "")) {
    titleInput.value = itinerary.title || "Untitled Trip";
  }
  if (dateInput && dateInput.value !== (itinerary.travel_date || "")) {
    dateInput.value = itinerary.travel_date || "";
  }
  if (routeStartInput && document.activeElement !== routeStartInput) {
    routeStartInput.value = itinerary.start_location_name || "";
  }
  if (routeEndInput && document.activeElement !== routeEndInput) {
    routeEndInput.value = itinerary.end_location_name || itinerary.destination || "";
  }
  if (routeHoursInput && document.activeElement !== routeHoursInput) {
    routeHoursInput.value = itinerary.available_hours || "";
  }
  if (routeInterestInput && !routeInterestInput.contains(document.activeElement)) {
    const savedInterests = getSavedInterests();
    routeInterestInput.querySelectorAll('input[name="route_interests"]').forEach(input => {
      input.checked = savedInterests.includes(normaliseInterest(input.value));
    });
  }
  const calculatedMinutes = getTotalRouteMinutesWithFinalLeg(recalculateStopTimesWithExistingTravel(stopDocs));

  if (hoursText) hoursText.textContent = formatMinutesAsDuration(calculatedMinutes);
  if (stopCountText) stopCountText.textContent = `${stopDocs.length} stops`;
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
  const visibleStops = draftStop ? [...stopDocs, draftStop] : stopDocs;
  const calculatedStops = recalculateStopTimesWithExistingTravel(visibleStops);
  stopList.classList.toggle("is-scrollable", visibleStops.length > 4);
  updateAddStopButtonState();
  if (stopCountText) stopCountText.textContent = `${stopDocs.length} stops`;

  if (!visibleStops.length) {
    stopList.innerHTML = `<div class="empty-soft">No stops yet.</div>`;
    return;
  }

  stopList.innerHTML = "";
  visibleStops.forEach((stop, index) => {
    const isDraft = stop.document_id === "__draft_stop__";
    const row = document.createElement("div");
    row.className = "edit-stop-row";
    if (editingStopId === stop.document_id) row.classList.add("is-editing");
    row.draggable = canEdit && !isDraft;
    row.dataset.stopId = stop.document_id;
    const calculatedStop = calculatedStops[index] || stop;
    const durationText = Number(calculatedStop.visit_duration_minutes || 0)
      ? `${Number(calculatedStop.visit_duration_minutes || 0)} mins visit`
      : "Estimated";
    const travelText = Number(calculatedStop.travel_minutes_from_previous || 0)
      ? `, ${Number(calculatedStop.travel_minutes_from_previous || 0)} mins travel`
      : "";
    const timeText = calculatedStop.arrival_time
      ? `${calculatedStop.arrival_time} - ${calculatedStop.departure_time || ""} - ${durationText}${travelText}`
      : durationText;
    row.innerHTML = `
      <div class="stop-number" title="Drag to reorder">${index + 1}</div>
      <div class="stop-main">
        <div class="stop-display">
          <div>
            <div class="stop-title">${escapeHtml(stop.stop_name || "Unnamed Stop")}</div>
            <div class="stop-subtitle">${escapeHtml(timeText)}</div>
          </div>
          ${canEdit ? `
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
      </div>
    `;

    row.addEventListener("dragstart", function () {
      if (isDraft) return;
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
      if (!canEdit || !draggedStopId || draggedStopId === stop.document_id) return;
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
      const saveButton = event.currentTarget;
      const warningElement = row.querySelector(".js-stop-warning");
      const placeChanges = getSelectedStopPlaceChanges(stop.document_id);

      const changes = {
        stop_name: nameInput?.value.trim() || "Unnamed Stop",
        visit_duration_minutes: Number(durationInput?.value || 0),
        ...placeChanges
      };

      runBusyAction(
        isDraft ? "create-stop" : `save-stop:${stop.document_id}`,
        saveButton,
        "Saving...",
        () => isDraft
          ? createStopFromDraft(index + 1, changes, saveButton?.dataset.confirmFar === "1", warningElement, saveButton)
          : saveStopChanges(stop.document_id, index + 1, changes, saveButton?.dataset.confirmFar === "1", warningElement, saveButton)
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

    setupStopPlaceAutocomplete(row, stop.document_id, stop);
    stopList.appendChild(row);
  });
}

async function updateStop(stopDocumentId, changes, activityText) {
  if (!canEdit) return;
  await updateDoc(doc(db, STOP_COLLECTION, stopDocumentId), {
    ...changes,
    updated_at: serverTimestamp()
  });
  await addActivity("stop_updated", `${currentUser.displayName || currentUser.email || "A collaborator"} ${activityText}`);
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
  const availableHours = Math.max(1, Number(routeHoursInput?.value || itinerary.available_hours || 1));
  const interests = getSelectedRouteInterests();
  const interest = interests[0] || "";

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
  itinerary = {
    ...itinerary,
    start_location_name: startPlace.name,
    start_latitude: startPlace.latitude,
    start_longitude: startPlace.longitude,
    end_location_name: endPlace.name,
    end_latitude: endPlace.latitude,
    end_longitude: endPlace.longitude,
    destination: endPlace.name,
    available_hours: availableHours,
    interest,
    interests
  };

  try {
    const timing = await recalculateStopTimesWithOsrm(stopDocs);
    const batch = writeBatch(db);

    stopDocs.forEach((stop, index) => {
      const recalculatedStop = timing.stops[index];
      if (!recalculatedStop) return;
      batch.update(doc(db, STOP_COLLECTION, stop.document_id), {
        stop_order: recalculatedStop.stop_order,
        arrival_time: recalculatedStop.arrival_time,
        departure_time: recalculatedStop.departure_time,
        travel_minutes_from_previous: Number(recalculatedStop.travel_minutes_from_previous || 0),
        updated_at: serverTimestamp()
      });
    });

    batch.update(doc(db, ITINERARY_COLLECTION, itinerary.document_id), {
      start_location_name: startPlace.name,
      start_latitude: startPlace.latitude,
      start_longitude: startPlace.longitude,
      end_location_name: endPlace.name,
      end_latitude: endPlace.latitude,
      end_longitude: endPlace.longitude,
      destination: endPlace.name,
      available_hours: availableHours,
      interest,
      interests,
      stop_count: stopDocs.length,
      travel_duration_minutes: timing.travelMinutes,
      total_duration_minutes: timing.totalMinutes,
      updated_at: serverTimestamp()
    });

    await batch.commit();
    selectedRoutePlaces = {};
    setRouteSaveMessage("Route details saved.");
    await addActivity("route_updated", `${currentUser.displayName || currentUser.email || "A collaborator"} updated the route details`);
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
    openConfirmModal(
      "Select a place",
      "Please choose a stop from the location suggestions so the itinerary has map coordinates.",
      null
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
  await addActivity("stop_updated", `${currentUser.displayName || currentUser.email || "A collaborator"} updated stop ${stopNumber}`);
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
  const recalculatedStops = timing.stops;

  const batch = writeBatch(db);
  recalculatedStops.forEach((stop, index) => {
    batch.update(doc(db, STOP_COLLECTION, stop.document_id), {
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
  await addActivity("stops_reordered", `${currentUser.displayName || currentUser.email || "A collaborator"} reordered stops`);
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
  await addActivity("stop_deleted", `${currentUser.displayName || currentUser.email || "A collaborator"} deleted ${stopName}`);
}

async function addStop() {
  if (!canEdit || !itinerary) return;
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
  draftStop = {
    document_id: "__draft_stop__",
    stop_order: stopDocs.length + 1,
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
    openConfirmModal(
      "Select a place",
      "Please choose a stop from the location suggestions so the itinerary has map coordinates.",
      null
    );
    return;
  }

  const stopRef = doc(collection(db, STOP_COLLECTION));
  const nextOrder = stopDocs.length + 1;
  const newStop = {
    document_id: stopRef.id,
    stop_order: nextOrder,
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
  await addActivity("stop_added", `${currentUser.displayName || currentUser.email || "A collaborator"} added ${cleanName}`);
}

function renderCollaborators() {
  if (!collaboratorList) return;
  if (peopleCount) {
    const acceptedCount = collaboratorDocs.filter(item => item.status === "accepted").length || 1;
    peopleCount.textContent = `${acceptedCount} ${acceptedCount === 1 ? "person" : "people"}`;
  }

  const sorted = [...collaboratorDocs].sort((a, b) => {
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
      <div class="collaborator-avatar">${escapeHtml(initials(name))}</div>
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
        updateCollaboratorRole(collaborator.document_id, roleSelect.value, collaborator.email).catch(console.error);
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

async function updateCollaboratorRole(collaboratorDocumentId, role, email) {
  if (!isOwner) return;
  await updateDoc(doc(db, COLLABORATOR_COLLECTION, collaboratorDocumentId), {
    role,
    updated_at: serverTimestamp()
  });
  await addActivity("role_changed", `${currentUser.displayName || currentUser.email || "Owner"} changed ${email} to ${role}`);
}

async function removeCollaborator(collaboratorDocumentId, email) {
  if (!isOwner) return;
  await deleteDoc(doc(db, COLLABORATOR_COLLECTION, collaboratorDocumentId));
  await addActivity("collaborator_removed", `${currentUser.displayName || currentUser.email || "Owner"} removed ${email}`);
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

  const registeredUser = await findRegisteredUserByEmail(email);
  const collaboratorRef = doc(collection(db, COLLABORATOR_COLLECTION));
  const baseInvite = {
    collaborator_id: collaboratorRef.id,
    itinerary_id: activeItineraryId,
    itinerary_document_id: itinerary.document_id,
    owner_id: itinerary.user_id,
    owner_email: normaliseEmail(currentUser.email),
    invited_by: currentUser.uid,
    invited_by_name: currentUser.displayName || currentUser.email || "Owner",
    email,
    role: "viewer",
    status: registeredUser ? "pending" : "pending_registration",
    created_at: serverTimestamp(),
    updated_at: serverTimestamp()
  };

  await setDoc(collaboratorRef, {
    ...baseInvite,
    user_id: registeredUser ? registeredUser.id : ""
  });

  await addActivity("invite_sent", `${currentUser.displayName || currentUser.email || "Owner"} invited ${email}`);

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
    const isEditing = editingCommentId === comment.document_id;
    const isNew = hasCommentsViewedState &&
      !isOwnComment &&
      timestampMillis(comment.created_at) > lastCommentsViewedAt;
    if (isNew) rememberTemporaryHighlight(temporaryCommentHighlights, comment.document_id);
    const showNewHighlight = isNew || hasTemporaryHighlight(temporaryCommentHighlights, comment.document_id);
    const row = document.createElement("div");
    row.className = `comment-row ${showNewHighlight ? "is-new" : ""}`;
    row.innerHTML = `
      <div class="comment-avatar">${escapeHtml(initials(comment.author_name || comment.author_email))}</div>
      <div class="comment-body">
        <div class="comment-name">${escapeHtml(comment.author_name || comment.author_email || "Collaborator")}</div>
        <div class="comment-time">${escapeHtml(formatRelativeTime(comment.created_at))}</div>
        ${isEditing
          ? `<textarea class="comment-edit-input js-comment-edit-input" maxlength="500">${escapeHtml(comment.text || "")}</textarea>`
          : `<div class="comment-text">${escapeHtml(comment.text || "")}</div>`}
      </div>
      ${isOwnComment
        ? `<div class="comment-actions">
            ${isEditing
              ? `<button type="button" class="btn btn-primary btn-sm js-save-comment">Save</button><button type="button" class="btn btn-secondary btn-sm js-cancel-comment">Cancel</button>`
              : `<button type="button" class="btn btn-secondary btn-sm js-edit-comment">Edit</button>
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
    return;
  }
  setCommentMessage("");
  await addDoc(collection(db, COMMENT_COLLECTION), {
    itinerary_id: activeItineraryId,
    itinerary_document_id: itinerary.document_id,
    author_id: currentUser.uid,
    author_name: currentUser.displayName || currentUser.email || "Collaborator",
    author_email: normaliseEmail(currentUser.email),
    text: trimmed,
    created_at: serverTimestamp()
  });
  await addActivity("comment_added", `${currentUser.displayName || currentUser.email || "A collaborator"} added a comment`);
}

async function updateComment(commentDocumentId, text) {
  const trimmed = text.trim();
  if (!currentUser) return;
  if (!trimmed) {
    setCommentMessage("Comment cannot be empty.", true);
    return;
  }
  setCommentMessage("");
  await updateDoc(doc(db, COMMENT_COLLECTION, commentDocumentId), {
    text: trimmed,
    edited_at: serverTimestamp()
  });
  editingCommentId = "";
  await addActivity("comment_updated", `${currentUser.displayName || currentUser.email || "A collaborator"} edited a comment`);
}

async function deleteComment(commentDocumentId) {
  if (!currentUser || !commentDocumentId) return;
  await deleteDoc(doc(db, COMMENT_COLLECTION, commentDocumentId));
  await addActivity("comment_deleted", `${currentUser.displayName || currentUser.email || "A collaborator"} deleted a comment`);
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
          <div class="activity-text">${escapeHtml(activity.message || "Itinerary updated")}</div>
          <div class="activity-time">${escapeHtml(formatRelativeTime(activity.created_at))}</div>
        </div>
      </div>
    `;
  }).join("");
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

  const stopsQuery = query(collection(db, STOP_COLLECTION), where("itinerary_id", "==", activeItineraryId));
  unsubscribeFns.push(onSnapshot(stopsQuery, snapshot => {
    stopDocs = snapshot.docs.map(item => ({ document_id: item.id, ...item.data() }))
      .sort((a, b) => Number(a.stop_order || 0) - Number(b.stop_order || 0));
    renderItinerary();
    renderStops();
  }));

  const collaboratorQuery = query(collection(db, COLLABORATOR_COLLECTION), where("itinerary_id", "==", activeItineraryId));
  unsubscribeFns.push(onSnapshot(collaboratorQuery, snapshot => {
    collaboratorDocs = snapshot.docs.map(item => ({ document_id: item.id, ...item.data() }));
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
  unsubscribeFns.push(onSnapshot(commentsQuery, snapshot => {
    latestCommentDocs = sortByCreatedDesc(snapshot.docs.map(item => ({ document_id: item.id, ...item.data() })));
    renderComments(latestCommentDocs.slice(0, 20));
    markCommentsViewedSoon(latestCommentDocs);
  }));

  subscribeToActivities();
}

function subscribeToActivities() {
  const activityQuery = allActivityMode
    ? query(collection(db, NOTIFICATION_COLLECTION), where("itinerary_id", "==", activeItineraryId))
    : query(collection(db, NOTIFICATION_COLLECTION), where("itinerary_id", "==", activeItineraryId));

  const activityUnsubscribe = onSnapshot(activityQuery, snapshot => {
    latestActivityDocs = sortByCreatedDesc(snapshot.docs.map(item => ({ document_id: item.id, ...item.data() })));
    renderActivities(allActivityMode ? latestActivityDocs : latestActivityDocs.slice(0, 5));
  });

  unsubscribeFns.push(activityUnsubscribe);
}

async function loadInitial(user) {
  currentUser = user;
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

titleInput?.addEventListener("input", function () {
  if (!canEdit || !itinerary) return;
  clearTimeout(titleSaveTimer);
  titleSaveTimer = setTimeout(async function () {
    const title = titleInput.value.trim() || "Untitled Trip";
    await updateDoc(doc(db, ITINERARY_COLLECTION, itinerary.document_id), {
      title,
      updated_at: serverTimestamp()
    });
    await addActivity("title_updated", `${currentUser.displayName || currentUser.email || "A collaborator"} updated the itinerary name`);
  }, 700);
});

dateInput?.addEventListener("change", async function () {
  if (!canEdit || !itinerary) return;
  await updateDoc(doc(db, ITINERARY_COLLECTION, itinerary.document_id), {
    travel_date: dateInput.value || "",
    updated_at: serverTimestamp()
  });
  await addActivity("date_updated", `${currentUser.displayName || currentUser.email || "A collaborator"} updated the itinerary date`);
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

inviteForm?.addEventListener("submit", function (event) {
  event.preventDefault();
  const submitButton = inviteForm.querySelector('button[type="submit"]');
  const email = normaliseEmail(inviteEmailInput?.value);
  if (!email || !email.includes("@")) {
    setInviteMessage("Enter a valid email address.", true);
    return;
  }
  runBusyAction(
    "invite-collaborator",
    submitButton,
    "Inviting...",
    () => inviteCollaborator(email)
  ).catch(error => {
    console.error("Invite failed:", error);
    setInviteMessage("Could not send the invite.", true);
  });
});

sendJoinEmailButton?.addEventListener("click", function () {
  const email = pendingInviteEmail || normaliseEmail(inviteEmailInput?.value);
  const tripTitle = itinerary?.title || titleInput?.value || "PandaJourney trip";
  const tripDate = itinerary?.travel_date ? formatDate(itinerary.travel_date) : "a planned travel date";
  const inviterName = currentUser?.displayName || currentUser?.email || "A PandaJourney user";
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
    .then(() => {
      if (commentInput) commentInput.value = "";
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
