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
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";

let currentUser = null;

// Change this if your Firebase collection name is lowercase.
const ITINERARY_COLLECTION = "Itinerary";
const ITINERARY_STOP_COLLECTION = "itinerary_stops";

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

  attractions.forEach((place, index) => {
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

  const match = String(text).match(/\d+/);
  return match ? parseInt(match[0], 10) : 0;
}

function normaliseCoordinate(value) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

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

function findTimetableItem(timetable, stopName) {
  if (!Array.isArray(timetable)) return {};

  return timetable.find(function (item) {
    return item.name === stopName || item.activity === stopName;
  }) || {};
}

// ================================
// Save Itinerary
// ================================

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

    const itineraryTitle = prompt(
      "Enter itinerary title:",
      destination + " Trip"
    );

    if (!itineraryTitle || !itineraryTitle.trim()) {
      alert("Save cancelled. Itinerary title is required.");
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

        waze_url: timetableItem.waze_url || "",

        created_at: serverTimestamp(),
        updated_at: serverTimestamp()
      });
    }

    alert("Itinerary saved successfully.");
    window.location.href = "/saved-itineraries";

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
      if (!validateTripDateTime()) {
        event.preventDefault();
      }
    });
  }

  updateMaximumStopsOptions();

  const availableHoursSelect = document.getElementById("available_hours");

  if (availableHoursSelect) {
    availableHoursSelect.addEventListener("change", updateMaximumStopsOptions);
  }

  initRouteMap();

  const saveButton = document.getElementById("save-itinerary-btn");

  if (saveButton) {
    saveButton.addEventListener("click", saveItinerary);
  }
});