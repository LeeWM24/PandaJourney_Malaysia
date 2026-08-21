import {
  auth,
  db
} from "./firebase-config.js";

import {
  onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-auth.js";

import {
  collection,
  doc,
  setDoc,
  serverTimestamp,
  query,
  where,
  getDocs
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

let currentUser = null;

const ITINERARY_COLLECTION = "Itinerary";
const ITINERARY_STOP_COLLECTION = "itinerary_stops";
const FAVOURITES_COLLECTION = "Favourites";

let favouritePlaces = [];
let favouriteSearchText = "";

// ================================
// Auth
// ================================

onAuthStateChanged(auth, function (user) {
  currentUser = user;

  const saveButton = document.getElementById("save-itinerary-btn");

  if (saveButton && !user) {
    saveButton.disabled = true;
    saveButton.textContent = "Login required";
  }

  if (user) {
    loadFavouritePlaces(user).catch(function (error) {
      console.error("Failed to load favourite places:", error);
      renderFavouriteError();
    });
  } else {
    renderFavouriteLoginRequired();
  }
});

// ================================
// Maximum Stops Logic
// ================================

function getStopLimitByHours(hours) {
  const parsedHours = parseInt(hours || "6", 10);
  return Math.max(1, Math.min(parsedHours - 3, 6));
}

function updateMaximumStopsOptions() {
  const availableHoursSelect = document.getElementById("available_hours");
  const maxStopsSelect = document.getElementById("max_stops");

  if (!availableHoursSelect || !maxStopsSelect) return;

  const stopLimit = getStopLimitByHours(availableHoursSelect.value);

  const currentValue = parseInt(
    maxStopsSelect.value || maxStopsSelect.dataset.selected || "3",
    10
  );

  const nextValue = Math.min(Math.max(currentValue, 1), stopLimit);

  maxStopsSelect.innerHTML = "";

  for (let stop = 1; stop <= stopLimit; stop += 1) {
    const option = document.createElement("option");

    option.value = String(stop);
    option.textContent = stop + (stop > 1 ? " stops" : " stop");

    if (stop === nextValue) {
      option.selected = true;
    }

    maxStopsSelect.appendChild(option);
  }
}

// ================================
// Loading UI
// ================================

function showPlannerLoading(message = "Generating itinerary...") {
  const overlay = document.getElementById("planner-loading-overlay");
  const textElement = document.getElementById("planner-loading-text");
  const generateButton = document.getElementById("generate-itinerary-btn");

  if (textElement) {
    textElement.textContent = message;
  }

  if (overlay) {
    overlay.style.display = "flex";
    overlay.setAttribute("aria-hidden", "false");
  }

  if (generateButton) {
    generateButton.disabled = true;
    generateButton.textContent = message.includes("Updating")
      ? "Updating route..."
      : "Generating...";
  }
}

function hidePlannerLoading() {
  const overlay = document.getElementById("planner-loading-overlay");
  const generateButton = document.getElementById("generate-itinerary-btn");

  if (overlay) {
    overlay.style.display = "none";
    overlay.setAttribute("aria-hidden", "true");
  }

  if (generateButton) {
    generateButton.disabled = false;
    generateButton.textContent = "⚡ Generate Itinerary";
  }
}

// ================================
// Browser GPS
// ================================

function setGpsStatus(message, isError = false) {
  const statusElement = document.getElementById("gps-location-status");

  if (!statusElement) return;

  statusElement.textContent = message;
  statusElement.style.color = isError ? "#dc2626" : "";
}

function useCurrentLocation() {
  const startInput = document.getElementById("start");
  const latitudeInput = document.getElementById("start_latitude");
  const longitudeInput = document.getElementById("start_longitude");
  const useCurrentLocationInput = document.getElementById("use_current_location");
  const gpsButton = document.getElementById("use-current-location-btn");

  if (!navigator.geolocation) {
    setGpsStatus("GPS is not supported by this browser.", true);
    return;
  }

  if (gpsButton) {
    gpsButton.disabled = true;
    gpsButton.textContent = "Detecting location...";
  }

  setGpsStatus("Detecting your current location...");

  navigator.geolocation.getCurrentPosition(
    function (position) {
      const latitude = position.coords.latitude;
      const longitude = position.coords.longitude;

      if (startInput) {
        startInput.value = "Current Location";
      }

      if (latitudeInput) {
        latitudeInput.value = String(latitude);
      }

      if (longitudeInput) {
        longitudeInput.value = String(longitude);
      }

      if (useCurrentLocationInput) {
        useCurrentLocationInput.value = "1";
      }

      setGpsStatus(`Current location selected (${latitude.toFixed(5)}, ${longitude.toFixed(5)}).`);

      if (gpsButton) {
        gpsButton.disabled = false;
        gpsButton.textContent = "📍 Use Current Location";
      }
    },
    function (error) {
      let message = "Unable to get current location.";

      if (error.code === error.PERMISSION_DENIED) {
        message = "Location permission was denied. Please allow location access or type a start location manually.";
      } else if (error.code === error.POSITION_UNAVAILABLE) {
        message = "Current location is unavailable. Please type a start location manually.";
      } else if (error.code === error.TIMEOUT) {
        message = "Location request timed out. Please try again.";
      }

      setGpsStatus(message, true);

      if (gpsButton) {
        gpsButton.disabled = false;
        gpsButton.textContent = "📍 Use Current Location";
      }
    },
    {
      enableHighAccuracy: true,
      timeout: 12000,
      maximumAge: 60000
    }
  );
}

function resetGpsWhenStartEdited() {
  const startInput = document.getElementById("start");
  const latitudeInput = document.getElementById("start_latitude");
  const longitudeInput = document.getElementById("start_longitude");
  const useCurrentLocationInput = document.getElementById("use_current_location");

  if (!startInput) return;

  startInput.addEventListener("input", function () {
    if (startInput.value !== "Current Location") {
      if (latitudeInput) latitudeInput.value = "";
      if (longitudeInput) longitudeInput.value = "";
      if (useCurrentLocationInput) useCurrentLocationInput.value = "0";
      setGpsStatus("");
    }
  });
}

// ================================
// Route Map
// ================================

function initRouteMap() {
  const mapDataElement = document.getElementById("map-data");
  const routeMapElement = document.getElementById("routeMap");

  if (!mapDataElement || !routeMapElement) return;
  if (typeof L === "undefined") return;

  const mapData = JSON.parse(mapDataElement.textContent);

  const startPoint = mapData.start;
  const endPoint = mapData.end;
  const attractions = mapData.attractions || [];
  const routeGeometry = mapData.routeGeometry;

  if (!startPoint || !endPoint) return;

  const map = L.map("routeMap").setView(
    [startPoint.latitude, startPoint.longitude],
    13
  );

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  }).addTo(map);

  const markerGroup = L.featureGroup();

  const startMarker = L.marker([startPoint.latitude, startPoint.longitude])
    .bindPopup("Start: " + mapData.startText)
    .addTo(map);

  markerGroup.addLayer(startMarker);

  attractions.forEach(function (place, index) {
    const marker = L.marker([place.latitude, place.longitude])
      .bindPopup((index + 1) + ". " + place.name)
      .addTo(map);

    markerGroup.addLayer(marker);
  });

  const endMarker = L.marker([endPoint.latitude, endPoint.longitude])
    .bindPopup("End: " + mapData.endText)
    .addTo(map);

  markerGroup.addLayer(endMarker);

  if (routeGeometry) {
    const routeLayer = L.geoJSON(routeGeometry).addTo(map);
    map.fitBounds(routeLayer.getBounds(), { padding: [24, 24] });
  } else {
    map.fitBounds(markerGroup.getBounds(), { padding: [24, 24] });
  }
}

// ================================
// Helper
// ================================

function getJsonData(elementId) {
  const element = document.getElementById(elementId);

  if (!element) return null;

  try {
    return JSON.parse(element.textContent);
  } catch (error) {
    console.error("Invalid JSON:", elementId, error);
    return null;
  }
}

function getFormValue(id, fallback = "") {
  const element = document.getElementById(id);
  return element ? element.value : fallback;
}

function extractNumberFromText(text) {
  if (!text) return 0;

  const value = String(text).toLowerCase();

  const hourMatch = value.match(/(\d+)\s*(hr|hour|hours|h)/);
  const minuteMatch = value.match(/(\d+)\s*(min|minute|minutes|m)/);

  let totalMinutes = 0;

  if (hourMatch) {
    totalMinutes += parseInt(hourMatch[1], 10) * 60;
  }

  if (minuteMatch) {
    totalMinutes += parseInt(minuteMatch[1], 10);
  }

  if (totalMinutes > 0) {
    return totalMinutes;
  }

  const match = value.match(/\d+/);
  return match ? parseInt(match[0], 10) : 0;
}

function normaliseCoordinate(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeCssValue(value) {
  if (window.CSS && CSS.escape) {
    return CSS.escape(String(value));
  }

  return String(value).replace(/"/g, '\\"');
}

// ================================
// Favourite Places
// ================================

function normaliseFavouritePlace(docSnap) {
  const data = docSnap.data();

  return {
    id: docSnap.id,
    place_id: docSnap.id,
    name: data.name || "Unnamed Favourite",
    area: data.area || "",
    category: data.category || "Favourite",
    latitude: Number(data.latitude || 0),
    longitude: Number(data.longitude || 0),
    rating: Number(data.rating || 0),
    image_url: data.image_url || "",
    source: "Favourites"
  };
}

async function loadFavouritePlaces(user) {
  const loadingElement = document.getElementById("favourites-loading");

  const favouriteQuery = query(
    collection(db, FAVOURITES_COLLECTION),
    where("user_id", "==", user.uid)
  );

  const snapshot = await getDocs(favouriteQuery);

  favouritePlaces = [];

  snapshot.forEach(function (docSnap) {
    favouritePlaces.push(normaliseFavouritePlace(docSnap));
  });

  if (loadingElement) {
    loadingElement.style.display = "none";
  }

  renderFavouritePlaces();
}

function renderFavouriteLoginRequired() {
  const loadingElement = document.getElementById("favourites-loading");

  if (loadingElement) {
    loadingElement.textContent = "Login is required to load favourite places.";
  }
}

function renderFavouriteError() {
  const loadingElement = document.getElementById("favourites-loading");

  if (loadingElement) {
    loadingElement.textContent = "Unable to load favourite places.";
  }
}

function getMaxStopsValue() {
  const maxStopsSelect = document.getElementById("max_stops");
  return maxStopsSelect ? Number(maxStopsSelect.value || 1) : 1;
}

function getSelectedFavouriteIds() {
  return Array.from(document.querySelectorAll(".js-favourite-place:checked"))
    .map(function (checkbox) {
      return checkbox.value;
    });
}

function getSelectedFavouritePlaces() {
  const selectedIds = getSelectedFavouriteIds();

  return selectedIds
    .map(function (id) {
      return favouritePlaces.find(function (place) {
        return place.id === id;
      });
    })
    .filter(Boolean);
}

function updateSelectedFavouritesHidden() {
  const hiddenInput = document.getElementById("selected_favourites_json");

  if (!hiddenInput) return;

  hiddenInput.value = JSON.stringify(getSelectedFavouritePlaces());
}

function getFilteredFavouritePlaces() {
  const keyword = favouriteSearchText.trim().toLowerCase();

  if (!keyword) {
    return favouritePlaces;
  }

  return favouritePlaces.filter(function (place) {
    return (
      String(place.name || "").toLowerCase().includes(keyword) ||
      String(place.category || "").toLowerCase().includes(keyword) ||
      String(place.area || "").toLowerCase().includes(keyword)
    );
  });
}

function enforceFavouriteLimit() {
  const maxStops = getMaxStopsValue();
  const selectedIds = getSelectedFavouriteIds();
  const checkboxes = document.querySelectorAll(".js-favourite-place");
  const helperText = document.getElementById("favourite-helper-text");

  checkboxes.forEach(function (checkbox) {
    checkbox.disabled = !checkbox.checked && selectedIds.length >= maxStops;
  });

  if (helperText) {
    helperText.textContent = `Select up to ${maxStops} favourite place${maxStops > 1 ? "s" : ""}. Selected favourites will use the available stop slots.`;
  }

  updateSelectedFavouritesHidden();
}

function renderFavouritePlaces() {
  const listElement = document.getElementById("favourites-list");

  if (!listElement) return;

  if (!favouritePlaces.length) {
    listElement.innerHTML = `
      <div class="favourite-place-meta">
        No favourite places found. Add favourites from the Attractions page first.
      </div>
    `;
    return;
  }

  const filteredFavouritePlaces = getFilteredFavouritePlaces();

  if (!filteredFavouritePlaces.length) {
    listElement.innerHTML = `
      <div class="favourite-place-meta">
        No favourite place matched your search.
      </div>
    `;
    return;
  }

  listElement.innerHTML = "";

  filteredFavouritePlaces.forEach(function (place) {
    const label = document.createElement("label");
    label.className = "favourite-place-option";

    label.innerHTML = `
      <input type="checkbox" class="js-favourite-place" value="${escapeHtml(place.id)}">
      <span>
        <span class="favourite-place-name">${escapeHtml(place.name)}</span>
        <br>
        <span class="favourite-place-meta">
          ${escapeHtml(place.category)}${place.rating ? ` · ⭐ ${escapeHtml(place.rating)}` : ""}
          ${place.area ? `<br>${escapeHtml(place.area)}` : ""}
        </span>
      </span>
    `;

    const checkbox = label.querySelector(".js-favourite-place");

    checkbox.addEventListener("change", function () {
      const maxStops = getMaxStopsValue();
      const selectedCount = getSelectedFavouriteIds().length;

      if (selectedCount > maxStops) {
        checkbox.checked = false;
        alert(`You can only select up to ${maxStops} favourite place${maxStops > 1 ? "s" : ""}.`);
      }

      enforceFavouriteLimit();
    });

    listElement.appendChild(label);
  });

  restoreSelectedFavouritesFromHidden();
  enforceFavouriteLimit();
}

function restoreSelectedFavouritesFromHidden() {
  const hiddenInput = document.getElementById("selected_favourites_json");

  if (!hiddenInput || !hiddenInput.value) return;

  try {
    const selected = JSON.parse(hiddenInput.value);

    const selectedIds = selected.map(function (place) {
      return place.id || place.place_id;
    });

    selectedIds.forEach(function (id) {
      const checkbox = document.querySelector(
        `.js-favourite-place[value="${escapeCssValue(id)}"]`
      );

      if (checkbox) {
        checkbox.checked = true;
      }
    });
  } catch (error) {
    console.warn("Unable to restore selected favourites:", error);
  }
}

// ================================
// Remove Stop
// ================================

function getExcludedStopNames() {
  const hiddenInput = document.getElementById("excluded_stop_names");

  if (!hiddenInput || !hiddenInput.value) return [];

  try {
    const names = JSON.parse(hiddenInput.value);
    return Array.isArray(names) ? names : [];
  } catch (error) {
    return [];
  }
}

function setExcludedStopNames(names) {
  const hiddenInput = document.getElementById("excluded_stop_names");

  if (hiddenInput) {
    hiddenInput.value = JSON.stringify(names);
  }
}

function setRegenerateToken() {
  const tokenInput = document.getElementById("regenerate_token");

  if (tokenInput) {
    tokenInput.value = String(Date.now());
  }
}

function validateFavouriteSelection() {
  const maxStops = getMaxStopsValue();
  const selectedCount = getSelectedFavouriteIds().length;

  if (selectedCount > maxStops) {
    alert(`Selected favourite places cannot exceed maximum stops (${maxStops}).`);
    return false;
  }

  updateSelectedFavouritesHidden();
  return true;
}

function submitPlannerForm(loadingText = "Generating itinerary...") {
  const itineraryForm = document.getElementById("itinerary-form");

  if (!itineraryForm) return;

  if (!validateTripDateTime()) return;
  if (!validateFavouriteSelection()) return;

  showPlannerLoading(loadingText);

  if (itineraryForm.requestSubmit) {
    itineraryForm.requestSubmit();
  } else {
    itineraryForm.submit();
  }
}

function removeStopAndRefresh(stopName) {
  const names = getExcludedStopNames();

  if (!names.includes(stopName)) {
    names.push(stopName);
  }

  setExcludedStopNames(names);
  setRegenerateToken();
  submitPlannerForm("Updating route...");
}

// ================================
// Date / Time Validation
// ================================

function getTodayDateKey() {
  const now = new Date();

  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

function getCurrentTimeKey() {
  const now = new Date();

  const hour = String(now.getHours()).padStart(2, "0");
  const minute = String(now.getMinutes()).padStart(2, "0");

  return `${hour}:${minute}`;
}

function updateDateTimeLimits() {
  const tripDateInput = document.getElementById("trip_date");
  const startTimeInput = document.getElementById("start_time");

  if (!tripDateInput || !startTimeInput) return;

  const today = getTodayDateKey();
  const currentTime = getCurrentTimeKey();

  tripDateInput.min = today;

  if (tripDateInput.value && tripDateInput.value < today) {
    tripDateInput.value = today;
  }

  if (tripDateInput.value === today) {
    startTimeInput.min = currentTime;

    if (startTimeInput.value && startTimeInput.value < currentTime) {
      startTimeInput.value = currentTime;
    }
  } else {
    startTimeInput.removeAttribute("min");
  }
}

function validateTripDateTime() {
  const tripDateInput = document.getElementById("trip_date");
  const startTimeInput = document.getElementById("start_time");

  if (!tripDateInput || !startTimeInput) return true;

  const today = getTodayDateKey();
  const currentTime = getCurrentTimeKey();

  if (tripDateInput.value < today) {
    alert("Travel date cannot be before today.");
    tripDateInput.value = today;
    return false;
  }

  if (tripDateInput.value === today && startTimeInput.value < currentTime) {
    alert("Start time cannot be earlier than the current time.");
    startTimeInput.value = currentTime;
    return false;
  }

  return true;
}

// ================================
// Save Title Modal
// ================================

let saveTitleResolver = null;

function openSaveTitleModal(defaultTitle) {
  const modal = document.getElementById("save-title-modal");
  const input = document.getElementById("save-itinerary-title-input");
  const errorElement = document.getElementById("save-title-error");

  if (!modal || !input) {
    return Promise.resolve(window.prompt("Enter itinerary title:", defaultTitle));
  }

  if (errorElement) {
    errorElement.style.display = "none";
  }

  input.value = defaultTitle || "";
  modal.style.display = "flex";
  modal.setAttribute("aria-hidden", "false");

  setTimeout(function () {
    input.focus();
    input.select();
  }, 50);

  return new Promise(function (resolve) {
    saveTitleResolver = resolve;
  });
}

function closeSaveTitleModal(value) {
  const modal = document.getElementById("save-title-modal");
  const errorElement = document.getElementById("save-title-error");

  if (modal) {
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
  }

  if (errorElement) {
    errorElement.style.display = "none";
  }

  if (saveTitleResolver) {
    saveTitleResolver(value);
    saveTitleResolver = null;
  }
}

function confirmSaveTitle() {
  const input = document.getElementById("save-itinerary-title-input");
  const errorElement = document.getElementById("save-title-error");

  const title = input ? input.value.trim() : "";

  if (!title) {
    if (errorElement) {
      errorElement.style.display = "block";
    }

    if (input) {
      input.focus();
    }

    return;
  }

  closeSaveTitleModal(title);
}

// ================================
// Save Success Modal
// ================================

function openSaveSuccessModal() {
  const modal = document.getElementById("save-success-modal");
  const okButton = document.getElementById("save-success-ok");

  if (!modal) {
    window.location.href = "/saved-itineraries";
    return;
  }

  modal.classList.add("show");
  modal.setAttribute("aria-hidden", "false");

  if (okButton) {
    okButton.focus();
  }
}

function closeSaveSuccessModal() {
  const modal = document.getElementById("save-success-modal");

  if (modal) {
    modal.classList.remove("show");
    modal.setAttribute("aria-hidden", "true");
  }

  window.location.href = "/saved-itineraries";
}

// ================================
// Save Itinerary
// ================================

function findTimetableItem(timetable, stopName) {
  if (!Array.isArray(timetable)) return {};

  return timetable.find(function (item) {
    return item.name === stopName || item.activity === stopName;
  }) || {};
}

async function saveItinerary() {
  const saveButton = document.getElementById("save-itinerary-btn");

  if (!currentUser) {
    alert("Please login before saving itinerary.");
    return;
  }

  const plan = getJsonData("plan-data");
  const mapData = getJsonData("map-data");

  if (!plan || !mapData) {
    alert("No generated itinerary found.");
    return;
  }

  try {
    saveButton.disabled = true;
    saveButton.textContent = "Saving...";

    const itineraryRef = doc(collection(db, ITINERARY_COLLECTION));
    const itineraryId = itineraryRef.id;

    const startPoint = mapData.start || {};
    const endPoint = mapData.end || {};

    const startText =
      mapData.startText ||
      getFormValue("start") ||
      "Start Location";

    const endText =
      mapData.endText ||
      getFormValue("end") ||
      "End Location";

    const destination = endText;

    const itineraryTitle = await openSaveTitleModal(
      destination + " Trip"
    );

    if (!itineraryTitle || !itineraryTitle.trim()) {
      saveButton.disabled = false;
      saveButton.textContent = "💾 Save";
      return;
    }

    const availableHours = Number(getFormValue("available_hours", 6));
    const minimumRating = Number(getFormValue("minimum_rating", 4.0));

    const travelDurationText =
      plan.travel_duration ||
      plan.total_duration ||
      "";

    const travelDurationMinutes =
      extractNumberFromText(travelDurationText);

    const totalDurationMinutes =
      availableHours * 60;

    const selectedStops =
      plan.selected ||
      mapData.attractions ||
      [];

    await setDoc(itineraryRef, {
      itinerary_id: itineraryId,
      user_id: currentUser.uid,

      title: itineraryTitle.trim(),
      destination: destination,

      start_location_name: startText,
      start_latitude: normaliseCoordinate(startPoint.latitude),
      start_longitude: normaliseCoordinate(startPoint.longitude),

      end_location_name: endText,
      end_latitude: normaliseCoordinate(endPoint.latitude),
      end_longitude: normaliseCoordinate(endPoint.longitude),

      travel_date: getFormValue("trip_date"),
      start_time: getFormValue("start_time"),

      available_hours: availableHours,
      minimum_rating: minimumRating,
      interest: getFormValue("interests", "culture"),

      total_distance_km: Number(plan.total_distance_km || 0),
      google_maps_full_route_url: plan.google_maps_full_route_url || "",
      travel_duration_minutes: travelDurationMinutes,
      total_duration_minutes: totalDurationMinutes,
      stop_count: selectedStops.length,

      status: "Draft",

      created_at: serverTimestamp(),
      updated_at: serverTimestamp(),
      published_at: null
    });

    for (let index = 0; index < selectedStops.length; index += 1) {
      const stop = selectedStops[index];
      const timetableItem = findTimetableItem(plan.timetable || [], stop.name);

      const stopRef = doc(collection(db, ITINERARY_STOP_COLLECTION));
      const stopId = stopRef.id;

      await setDoc(stopRef, {
        stop_id: stopId,
        itinerary_id: itineraryId,

        place_id: stop.id || stop.place_id || "",
        stop_order: index + 1,

        stop_name: stop.name || "Unnamed Stop",
        category: stop.category || stop.type || getFormValue("interests", "culture"),
        rating: Number(stop.rating || 0),

        latitude: normaliseCoordinate(stop.latitude),
        longitude: normaliseCoordinate(stop.longitude),

        arrival_time: timetableItem.arrival_time || timetableItem.time || "",
        departure_time: timetableItem.departure_time || "",
        visit_duration_minutes: Number(stop.estimated_minutes || 0),

        travel_minutes_from_previous: extractNumberFromText(timetableItem.transport || ""),

        google_maps_url: timetableItem.google_maps_url || "",
        google_maps_label: timetableItem.google_maps_label || "",
        route_leg_from: timetableItem.route_leg_from || "",
        route_leg_to: timetableItem.route_leg_to || "",

        created_at: serverTimestamp(),
        updated_at: serverTimestamp()
      });
    }

    openSaveSuccessModal();

  } catch (error) {
    console.error("Failed to save itinerary:", error);
    alert("Failed to save itinerary. Please check console.");

    saveButton.disabled = false;
    saveButton.textContent = "💾 Save";
  }
}

// ================================
// Init
// ================================

document.addEventListener("DOMContentLoaded", function () {
  updateDateTimeLimits();

  const tripDateInput = document.getElementById("trip_date");
  const startTimeInput = document.getElementById("start_time");
  const itineraryForm = document.getElementById("itinerary-form");

  if (tripDateInput) {
    tripDateInput.addEventListener("change", updateDateTimeLimits);
  }

  if (startTimeInput) {
    startTimeInput.addEventListener("change", validateTripDateTime);
  }

  if (itineraryForm) {
    itineraryForm.addEventListener("submit", function (event) {
      if (!validateTripDateTime() || !validateFavouriteSelection()) {
        event.preventDefault();
        hidePlannerLoading();
        return;
      }

      showPlannerLoading("Generating itinerary...");
    });
  }

  updateMaximumStopsOptions();

  const availableHoursSelect = document.getElementById("available_hours");

  if (availableHoursSelect) {
    availableHoursSelect.addEventListener("change", function () {
      updateMaximumStopsOptions();
      enforceFavouriteLimit();
    });
  }

  const maxStopsSelect = document.getElementById("max_stops");

  if (maxStopsSelect) {
    maxStopsSelect.addEventListener("change", enforceFavouriteLimit);
  }

  const useCurrentLocationButton = document.getElementById("use-current-location-btn");

  if (useCurrentLocationButton) {
    useCurrentLocationButton.addEventListener("click", useCurrentLocation);
  }

  resetGpsWhenStartEdited();

  const favouritesSearchInput = document.getElementById("favourites-search");

  if (favouritesSearchInput) {
    favouritesSearchInput.addEventListener("input", function () {
      favouriteSearchText = favouritesSearchInput.value || "";
      renderFavouritePlaces();
    });
  }

  document.querySelectorAll(".js-remove-stop").forEach(function (button) {
    button.addEventListener("click", function () {
      const stopName = button.dataset.stopName;

      if (stopName) {
        removeStopAndRefresh(stopName);
      }
    });
  });

  initRouteMap();

  const cancelSaveTitleButton = document.getElementById("cancel-save-title-btn");
  const confirmSaveTitleButton = document.getElementById("confirm-save-title-btn");
  const saveTitleInput = document.getElementById("save-itinerary-title-input");
  const saveTitleModal = document.getElementById("save-title-modal");

  if (cancelSaveTitleButton) {
    cancelSaveTitleButton.addEventListener("click", function () {
      closeSaveTitleModal(null);
    });
  }

  if (confirmSaveTitleButton) {
    confirmSaveTitleButton.addEventListener("click", confirmSaveTitle);
  }

  if (saveTitleInput) {
    saveTitleInput.addEventListener("keydown", function (event) {
      if (event.key === "Enter") {
        event.preventDefault();
        confirmSaveTitle();
      }

      if (event.key === "Escape") {
        closeSaveTitleModal(null);
      }
    });
  }

  if (saveTitleModal) {
    saveTitleModal.addEventListener("click", function (event) {
      if (event.target === saveTitleModal) {
        closeSaveTitleModal(null);
      }
    });
  }

  const saveButton = document.getElementById("save-itinerary-btn");

  if (saveButton) {
    saveButton.addEventListener("click", saveItinerary);
  }

  const saveSuccessOkButton = document.getElementById("save-success-ok");
  const saveSuccessModal = document.getElementById("save-success-modal");

  if (saveSuccessOkButton) {
    saveSuccessOkButton.addEventListener("click", closeSaveSuccessModal);
  }

  if (saveSuccessModal) {
    saveSuccessModal.addEventListener("click", function (event) {
      if (event.target === saveSuccessModal) {
        closeSaveSuccessModal();
      }
    });
  }

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape") {
      const modal = document.getElementById("save-success-modal");

      if (modal && modal.classList.contains("show")) {
        closeSaveSuccessModal();
      }
    }
  });
});