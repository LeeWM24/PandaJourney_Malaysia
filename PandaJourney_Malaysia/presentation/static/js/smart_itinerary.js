import {
  auth,
  db
} from "./firebase-config.js";

import {
  collection,
  doc,
  getDocs,
  query,
  serverTimestamp,
  setDoc,
  where
} from "https://www.gstatic.com/firebasejs/12.1.0/firebase-firestore.js";


// =====================================================
// CONSTANTS / STATE
// =====================================================

const ITINERARY_COLLECTION = "Itinerary";
const ITINERARY_STOP_COLLECTION = "itinerary_stops";
const FAVOURITES_COLLECTION = "Favourites";

const FAVOURITES_CACHE_PREFIX =
  "pandajourney:favouritePlaces:";

const ITINERARY_STATE_KEY =
  "pandajourney:smartItineraryState";

const MAX_ITINERARY_TITLE_LENGTH = 50;
const MAX_LOCATION_DISPLAY_LENGTH = 40;

const RUNTIME_BINDING_ATTRIBUTES = [
  "data-detail-bound",
  "data-remove-bound",
  "data-save-bound",
  "data-edit-bound",
  "data-result-bound",
  "data-map-initialised"
];


const ITINERARY_PLACEHOLDER_IMAGE =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(`
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 800 450"
    >
      <rect
        width="800"
        height="450"
        fill="#e8f7ef"
      />

      <circle
        cx="400"
        cy="190"
        r="62"
        fill="#bfe7cf"
      />

      <path
        d="M400 120c-39 0-70 31-70 70 0 53 70 130 70 130s70-77 70-130c0-39-31-70-70-70zm0 98a28 28 0 1 1 0-56 28 28 0 0 1 0 56z"
        fill="#059669"
      />

      <text
        x="400"
        y="375"
        text-anchor="middle"
        font-family="Arial"
        font-size="28"
        fill="#47685b"
      >
        Attraction
      </text>
    </svg>
  `);


const PROJECT_DEMO_IMAGE_MARKERS = [
  "images.unsplash.com/photo-1512453979798-5ea266f8880c",
  "images.unsplash.com/photo-1500530855697-b586d89ba3ee",
  "images.unsplash.com/photo-1494526585095-c41746248156",
  "images.unsplash.com/photo-1534452203293-494d7ddbf7e0",
  "images.unsplash.com/photo-1519677100203-a0e668c92439",
  "images.unsplash.com/photo-1500534314209-a25ddb2bd429",
  "images.unsplash.com/photo-1495121605193-b116b5b9c5d8",
  "images.unsplash.com/photo-1470337458703-46ad1756a187",
  "images.unsplash.com/photo-1533196350647-8cef3c2d9f85",
  "images.unsplash.com/photo-1504674900247-0877df9cc836",
  "images.unsplash.com/photo-1540189549336-e6e99c3679fe",
  "images.unsplash.com/photo-1528716321682-0a570e4cc34e",
  "images.unsplash.com/photo-1493558103817-58b2924bce98",
  "images.unsplash.com/photo-1507525428034-b723cf961d3e",
  "images.unsplash.com/photo-1526481280694-3df0480fd2f7",
  "images.unsplash.com/photo-1596422846543-75c6fc197f07"
];


let currentUser = null;

let savedItineraryDocumentId = "";

let saveInProgress = false;

let saveTitleResolver = null;

let favouritePlaces = [];

let favouriteSearchText = "";

let itineraryStateClearedForHandoff = false;

const detailPhotoCache = new Map();


// =====================================================
// BASIC HELPERS
// =====================================================

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}


function escapeCssValue(value) {
  if (
    window.CSS &&
    CSS.escape
  ) {
    return CSS.escape(
      String(value)
    );
  }

  return String(value)
    .replace(
      /"/g,
      '\\"'
    );
}


function getJsonData(elementId) {
  const element =
    document.getElementById(
      elementId
    );

  if (!element) {
    return null;
  }

  try {
    return JSON.parse(
      element.textContent
    );
  } catch (error) {
    console.error(
      "Invalid JSON:",
      elementId,
      error
    );

    return null;
  }
}


function getFormValue(
  id,
  fallback = ""
) {
  const element =
    document.getElementById(id);

  return element
    ? element.value
    : fallback;
}


function normaliseCoordinate(value) {
  const numberValue =
    Number(value);

  return Number.isFinite(
    numberValue
  )
    ? numberValue
    : 0;
}


function extractNumberFromText(text) {
  if (!text) {
    return 0;
  }

  const value =
    String(text)
      .toLowerCase();

  const hourMatch =
    value.match(
      /(\d+)\s*(hr|hour|hours|h)/
    );

  const minuteMatch =
    value.match(
      /(\d+)\s*(min|minute|minutes|m)/
    );

  let totalMinutes = 0;

  if (hourMatch) {
    totalMinutes +=
      parseInt(
        hourMatch[1],
        10
      ) * 60;
  }

  if (minuteMatch) {
    totalMinutes +=
      parseInt(
        minuteMatch[1],
        10
      );
  }

  if (totalMinutes > 0) {
    return totalMinutes;
  }

  const match =
    value.match(/\d+/);

  return match
    ? parseInt(
        match[0],
        10
      )
    : 0;
}


function truncateText(
  value,
  maxLength
) {
  const text =
    String(value || "")
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  if (
    text.length <=
    maxLength
  ) {
    return text;
  }

  return (
    text
      .slice(
        0,
        Math.max(
          1,
          maxLength - 3
        )
      )
      .trimEnd()
    +
    "..."
  );
}


function shortLocationName(
  value,
  maxLength =
    MAX_LOCATION_DISPLAY_LENGTH
) {
  const text =
    String(value || "")
      .replace(
        /\s+/g,
        " "
      )
      .trim();

  if (!text) {
    return "";
  }

  if (
    text.toLowerCase() ===
    "current location"
  ) {
    return "Current Location";
  }

  const parts =
    text
      .split(",")
      .map(
        part =>
          part.trim()
      )
      .filter(Boolean);

  let shortName =
    parts[0] ||
    text;

  if (
    /^\d+$/.test(
      shortName.replace(
        /\s+/g,
        ""
      )
    ) &&
    parts.length > 1
  ) {
    shortName =
      `${shortName}, ${parts[1]}`;
  }

  return truncateText(
    shortName,
    maxLength
  );
}


function getSelectedInterests() {
  return Array.from(
    document.querySelectorAll(
      'input[name="interests"]:checked'
    )
  ).map(
    input =>
      input.value
  );
}


function hasUsableDetailText(value) {
  const text =
    String(value || "")
      .trim();

  if (!text) {
    return false;
  }

  return ![
    "n/a",
    "not available",
    "no description available",
    "no description available."
  ].includes(
    text.toLowerCase()
  );
}


function hasRealDescription(
  attraction = {}
) {
  if (
    !hasUsableDetailText(
      attraction.description
    )
  ) {
    return false;
  }

  const description =
    String(
      attraction.description
    )
      .trim()
      .toLowerCase();

  const name =
    String(
      attraction.name || ""
    )
      .trim()
      .toLowerCase();

  return !(
    name &&
    description.includes(
      `${name} is a popular`
    ) &&
    description.includes(
      "destination in malaysia with excellent visitor facilities"
    )
  );
}


function getFallbackAttractionDescription(
  detail = {}
) {
  const category =
    attractionCategory(
      detail
    );

  if (
    !category ||
    [
      "Attraction",
      "Tourist Attraction",
      "Tourist Attractions",
      "Point Of Interest"
    ].includes(category)
  ) {
    return "";
  }

  return `A ${category.toLowerCase()} included as a stop in this itinerary.`;
}


function cleanAboutText(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}


function getShortSourceDescription(value) {
  const text =
    cleanAboutText(value);

  if (!hasUsableDetailText(text)) {
    return "";
  }

  const sentences =
    text.match(/[^.!?]+[.!?]+|[^.!?]+$/g) ||
    [];

  return sentences
    .slice(0, 2)
    .join(" ")
    .trim();
}


function getDetailTextList(value) {
  if (Array.isArray(value)) {
    return value.flatMap(getDetailTextList);
  }

  if (value && typeof value === "object") {
    return Object
      .entries(value)
      .flatMap(function ([key, nestedValue]) {
        if (typeof nestedValue === "boolean") {
          return nestedValue ? [key] : [];
        }

        return getDetailTextList(nestedValue);
      });
  }

  const text =
    cleanAboutText(value)
      .replace(/_/g, " ");

  return text ? [text] : [];
}


function uniqueDetailValues(values) {
  const seen =
    new Set();

  return values
    .map(formatCategoryLabel)
    .filter(function (value) {
      const key =
        value.toLowerCase();

      if (!value || seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
}


function uniqueCleanValues(values) {
  const seen =
    new Set();

  return values
    .map(cleanAboutText)
    .filter(function (value) {
      const key =
        value.toLowerCase();

      if (!value || seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    });
}


function getAboutFeatureValues(detail = {}) {
  return uniqueDetailValues([
    ...getDetailTextList(detail.place_highlights),
    ...getDetailTextList(detail.place_features),
    ...getDetailTextList(detail.source_types),
    ...getDetailTextList(detail.source_extensions),
    ...getDetailTextList(detail.service_options)
  ]);
}


function getAboutArea(detail = {}) {
  const directArea =
    cleanAboutText(
      detail.area ||
      detail.neighbourhood ||
      detail.city ||
      ""
    );

  if (directArea && directArea.toLowerCase() !== "malaysia") {
    return directArea;
  }

  const nameAreaMatch =
    cleanAboutText(detail.name)
      .match(/(?:·|-)\s*([^·-]+)$/);

  if (nameAreaMatch?.[1]) {
    return nameAreaMatch[1].trim();
  }

  const addressParts =
    cleanAboutText(
      detail.address ||
      detail.location ||
      ""
    )
      .split(",")
      .map(part => part.trim())
      .filter(Boolean)
      .filter(part => part.toLowerCase() !== "malaysia");

  return (
    addressParts.find(part => !/^\d/.test(part) && !/^jalan\b/i.test(part)) ||
    addressParts[0] ||
    ""
  );
}


function hasFeatureKeyword(feature, keywords) {
  const text =
    feature.toLowerCase();

  return keywords.some(keyword => text.includes(keyword));
}


function getPrimaryAboutGroup(detail = {}) {
  const interestText =
    getDetailTextList([
      detail.matched_interests,
      detail.interest_tags,
      detail.interests,
      detail.tags
    ])
      .join(" ")
      .toLowerCase();

  const categoryText =
    [
      attractionCategory(detail),
      ...getAboutFeatureValues(detail)
    ]
      .join(" ")
      .toLowerCase();

  const hasAny =
    (text, keywords) =>
      keywords.some(keyword => text.includes(keyword));

  if (hasAny(interestText, ["culture", "heritage", "museum", "art", "gallery"])) {
    return "culture";
  }

  if (hasAny(interestText, ["shopping", "mall", "market"])) {
    return "shopping";
  }

  if (hasAny(interestText, ["nature", "park", "garden", "outdoor"])) {
    return "nature";
  }

  if (hasAny(interestText, ["food", "restaurant", "cafe", "dining"])) {
    return "food";
  }

  if (hasAny(categoryText, ["museum", "heritage", "cultural", "gallery", "art"])) {
    return "culture";
  }

  if (hasAny(categoryText, ["shopping", "mall", "market", "retail", "fashion"])) {
    return "shopping";
  }

  if (hasAny(categoryText, ["park", "garden", "lake", "hiking", "trail", "outdoor", "nature"])) {
    return "nature";
  }

  if (hasAny(categoryText, ["restaurant", "food", "cafe", "bakery", "dining", "coffee"])) {
    return "food";
  }

  return "generic";
}


function getAboutIdentity(detail, group) {
  const category =
    attractionCategory(detail);

  if (group === "culture") {
    const categoryText =
      category.toLowerCase();

    if (categoryText.includes("museum") || categoryText.includes("gallery")) {
      return category.toLowerCase();
    }

    return "cultural attraction";
  }

  if (group === "shopping") {
    return "shopping destination";
  }

  if (group === "nature") {
    return "outdoor attraction";
  }

  if (category && category !== "Attraction") {
    return category.toLowerCase();
  }

  return "attraction";
}


function foodFeaturePhrase(feature) {
  const lower =
    feature.toLowerCase();

  if (lower.includes("chinese")) {
    return "Chinese dining options";
  }

  if (lower.includes("malaysian")) {
    return "Malaysian dining options";
  }

  if (lower.includes("restaurant") || lower.includes("cuisine") || lower.includes("dining")) {
    return `${feature} options`;
  }

  if (lower.includes("dessert")) {
    return "desserts";
  }

  if (lower.includes("dine in") || lower.includes("dine-in")) {
    return "dine-in service";
  }

  if (lower.includes("takeaway") || lower.includes("takeout")) {
    return "takeaway service";
  }

  return feature.toLowerCase();
}


function getAboutFeaturePhrases(detail, group) {
  const features =
    getAboutFeatureValues(detail);

  const keywordsByGroup = {
    food: ["cuisine", "restaurant", "dining", "food", "cafe", "coffee", "dessert", "takeaway", "takeout", "dine in", "chinese", "malaysian"],
    culture: ["art", "artwork", "craft", "cultural", "exhibit", "gallery", "handicraft", "heritage", "histor"],
    shopping: ["brand", "cinema", "dining", "entertainment", "fashion", "market", "retail", "shopping", "store"],
    nature: ["forest", "garden", "hiking", "lake", "outdoor", "park", "recreation", "trail", "viewpoint", "waterfall"]
  };

  const groupKeywords =
    keywordsByGroup[group] ||
    [];

  const matchingFeatures =
    groupKeywords.length
      ? features.filter(feature => hasFeatureKeyword(feature, groupKeywords))
      : features;

  const foodKeywords =
    keywordsByGroup.food;

  const selectedFeatures =
    matchingFeatures.length
      ? matchingFeatures
      : features.filter(feature => hasFeatureKeyword(feature, foodKeywords));

  return uniqueCleanValues(
    selectedFeatures
      .slice(0, 3)
      .map(feature => {
        if (group === "food" || hasFeatureKeyword(feature, foodKeywords)) {
          return foodFeaturePhrase(feature);
        }

        return feature.toLowerCase();
      })
  );
}


function joinNaturalList(values) {
  if (values.length <= 1) {
    return values[0] || "";
  }

  if (values.length === 2) {
    return `${values[0]} and ${values[1]}`;
  }

  return `${values.slice(0, -1).join(", ")} and ${values[values.length - 1]}`;
}


function buildAttractionAboutSentence(detail = {}) {
  const sourceDescription =
    getShortSourceDescription(detail.source_description) ||
    (
      hasRealDescription(detail)
        ? getShortSourceDescription(detail.description)
        : ""
    );

  if (sourceDescription) {
    return sourceDescription;
  }

  const sourceSnippet =
    getShortSourceDescription(detail.source_snippet || detail.snippet);

  if (sourceSnippet) {
    return sourceSnippet;
  }

  const name =
    cleanAboutText(detail.name) ||
    "This stop";

  const group =
    getPrimaryAboutGroup(detail);

  const identity =
    getAboutIdentity(detail, group);

  const area =
    getAboutArea(detail);

  const areaText =
    area
      ? ` in ${area}`
      : "";

  const featurePhrases =
    getAboutFeaturePhrases(detail, group);

  if (
    group === "culture" &&
    featurePhrases.some(phrase => hasFeatureKeyword(phrase, ["dining", "restaurant", "cuisine", "food", "coffee", "dessert"]))
  ) {
    return `${name} is a ${identity}${areaText}, with ${joinNaturalList(featurePhrases)} available at the location.`;
  }

  if (featurePhrases.length) {
    const verb =
      group === "food"
        ? "offering"
        : "featuring";

    return `${name} is a ${identity}${areaText} ${verb} ${joinNaturalList(featurePhrases)}.`;
  }

  if (area) {
    return `${name} is a ${identity} located in ${area}.`;
  }

  return getFallbackAttractionDescription(detail) ||
    `${name} is a ${identity} included as a stop in this itinerary.`;
}


function getAttractionAboutDescription(detail = {}) {
  const description =
    buildAttractionAboutSentence(detail);

  return hasUsableDetailText(description)
    ? description
    : "";
}


function getDetailList(value) {
  return (
    Array.isArray(value)
      ? value
      : [value]
  )
    .map(
      item =>
        String(item || "")
          .trim()
    )
    .filter(Boolean);
}


function setSectionVisibility(
  sectionId,
  visible
) {
  const section =
    document.getElementById(
      sectionId
    );

  if (section) {
    section.hidden =
      !visible;
  }
}


function formatCategoryLabel(value) {
  return String(value || "")
    .trim()
    .replace(
      /\b\w/g,
      char =>
        char.toUpperCase()
    );
}


function attractionCategory(
  attraction = {}
) {
  const directCategory =
    String(
      attraction.category ||
      attraction.type ||
      attraction.place_type ||
      ""
    ).trim();

  const genericCategories =
    new Set([
      "",
      "attraction",
      "tourist attraction",
      "tourist attractions",
      "point of interest"
    ]);

  if (
    directCategory &&
    !genericCategories.has(
      directCategory.toLowerCase()
    )
  ) {
    return formatCategoryLabel(
      directCategory
    );
  }


  const matchedInterests =
    Array.isArray(
      attraction.matched_interests
    )
      ? attraction.matched_interests
      : [];

  if (
    matchedInterests.length > 0
  ) {
    return formatCategoryLabel(
      matchedInterests[0]
    );
  }


  const interests =
    Array.isArray(
      attraction.interests
    )
      ? attraction.interests
      : [];

  const usefulInterest =
    interests.find(
      value => {
        const text =
          String(value || "")
            .trim()
            .toLowerCase();

        return ![
          "",
          "favourite",
          "attraction",
          "tourist attraction"
        ].includes(text);
      }
    );

  if (usefulInterest) {
    return formatCategoryLabel(
      usefulInterest
    );
  }


  const tags =
    Array.isArray(
      attraction.tags
    )
      ? attraction.tags
      : [];

  const usefulTag =
    tags.find(
      value => {
        const text =
          String(value || "")
            .trim()
            .toLowerCase();

        return ![
          "",
          "favourite",
          "attraction",
          "tourist attraction",
          "indoor",
          "outdoor"
        ].includes(text);
      }
    );

  if (usefulTag) {
    return formatCategoryLabel(
      usefulTag
    );
  }

  return "Attraction";
}


function getAttractionImage(
  attraction = {}
) {
  const imageUrl =
    String(
      attraction.image_url ||
      ""
    ).trim();

  if (
    isUsableAttractionImage(
      imageUrl
    )
  ) {
    return imageUrl;
  }


  if (
    Array.isArray(
      attraction.photo_urls
    )
  ) {
    const photo =
      attraction.photo_urls.find(
        value =>
          isUsableAttractionImage(
            value
          )
      );

    if (photo) {
      return String(
        photo
      ).trim();
    }
  }

  return "";
}


function isUsableAttractionImage(
  url
) {
  const value =
    String(
      url ||
      ""
    ).trim();

  if (!value) {
    return false;
  }

  const lowerValue =
    value.toLowerCase();

  if (
    value ===
      ITINERARY_PLACEHOLDER_IMAGE ||
    lowerValue.startsWith(
      "data:image/svg+xml"
    )
  ) {
    return false;
  }

  return !PROJECT_DEMO_IMAGE_MARKERS.some(
    marker =>
      lowerValue.includes(
        marker
      )
  );
}


async function getPlaceDetailPhoto(
  placeName
) {
  const name =
    String(
      placeName || ""
    ).trim();

  if (!name) {
    return "";
  }


  if (
    detailPhotoCache.has(
      name
    )
  ) {
    return await detailPhotoCache.get(
      name
    );
  }


  const promise =
    fetch(
      `/api/public-place-photo?name=${encodeURIComponent(name)}`
    )
      .then(
        response =>
          response.ok
            ? response.json()
            : null
      )
      .then(
        data => {
          const imageUrl =
            data?.image_url ||
            "";

          return isUsableAttractionImage(
            imageUrl
          )
            ? imageUrl
            : "";
        }
      )
      .catch(
        () => ""
      );


  detailPhotoCache.set(
    name,
    promise
  );


  return await promise;
}


function getUserFacingRecommendationReasons(
  detail = {}
) {
  const raw =
    detail.reason_tags ||
    detail.reasons ||
    detail.why_recommended ||
    [];


  return getDetailList(raw)
    .filter(
      reason => {
        const text =
          reason.toLowerCase();

        if (
          text.includes(
            "less close to route"
          )
        ) {
          return false;
        }

        if (
          text.includes(
            "penalised"
          ) ||
          text.includes(
            "penalized"
          )
        ) {
          return false;
        }

        return true;
      }
    );
}


// =====================================================
// ALERT MODAL
// =====================================================

function openPlannerAlertModal(
  title,
  message,
  icon = "!"
) {
  const modal =
    document.getElementById(
      "planner-alert-modal"
    );

  const iconElement =
    document.getElementById(
      "planner-alert-icon"
    );

  const titleElement =
    document.getElementById(
      "planner-alert-title"
    );

  const messageElement =
    document.getElementById(
      "planner-alert-message"
    );

  const okButton =
    document.getElementById(
      "planner-alert-ok"
    );


  if (!modal) {
    console.warn(message);
    return;
  }


  if (iconElement) {
    iconElement.textContent =
      icon;
  }

  if (titleElement) {
    titleElement.textContent =
      title;
  }

  if (messageElement) {
    messageElement.textContent =
      message;
  }


  modal.classList.add(
    "show"
  );

  modal.setAttribute(
    "aria-hidden",
    "false"
  );

  okButton?.focus();
}


function closePlannerAlertModal() {
  const modal =
    document.getElementById(
      "planner-alert-modal"
    );

  if (!modal) {
    return;
  }

  modal.classList.remove(
    "show"
  );

  modal.setAttribute(
    "aria-hidden",
    "true"
  );
}


// =====================================================
// MAXIMUM STOPS
// =====================================================

function getStopLimitByHours(hours) {
  const parsedHours =
    parseInt(
      hours || "6",
      10
    );

  return Math.max(
    1,
    Math.min(
      parsedHours - 3,
      6
    )
  );
}


function updateMaximumStopsOptions() {
  const availableHoursSelect =
    document.getElementById(
      "available_hours"
    );

  const maxStopsSelect =
    document.getElementById(
      "max_stops"
    );

  if (
    !availableHoursSelect ||
    !maxStopsSelect
  ) {
    return;
  }


  const stopLimit =
    getStopLimitByHours(
      availableHoursSelect.value
    );


  const currentValue =
    parseInt(
      maxStopsSelect.value ||
      maxStopsSelect.dataset.selected ||
      "3",
      10
    );


  const nextValue =
    Math.min(
      Math.max(
        currentValue,
        1
      ),
      stopLimit
    );


  maxStopsSelect.innerHTML =
    "";


  for (
    let stop = 1;
    stop <= stopLimit;
    stop += 1
  ) {
    const option =
      document.createElement(
        "option"
      );

    option.value =
      String(stop);

    option.textContent =
      `${stop} ${stop > 1 ? "stops" : "stop"}`;

    option.selected =
      stop ===
      nextValue;

    maxStopsSelect.appendChild(
      option
    );
  }
}


// =====================================================
// LOADING
// =====================================================

function showPlannerLoading(
  message =
    "Generating itinerary..."
) {
  const overlay =
    document.getElementById(
      "planner-loading-overlay"
    );

  const textElement =
    document.getElementById(
      "planner-loading-text"
    );

  const generateButton =
    document.getElementById(
      "generate-itinerary-btn"
    );


  if (textElement) {
    textElement.textContent =
      message;
  }


  if (overlay) {
    overlay.style.display =
      "flex";

    overlay.setAttribute(
      "aria-hidden",
      "false"
    );
  }


  if (generateButton) {
    generateButton.disabled =
      true;

    generateButton.textContent =
      message.includes(
        "Updating"
      )
        ? "Updating route..."
        : "Generating...";
  }
}


function hidePlannerLoading() {
  const overlay =
    document.getElementById(
      "planner-loading-overlay"
    );

  const generateButton =
    document.getElementById(
      "generate-itinerary-btn"
    );


  if (overlay) {
    overlay.style.display =
      "none";

    overlay.setAttribute(
      "aria-hidden",
      "true"
    );
  }


  if (generateButton) {
    generateButton.disabled =
      false;

    generateButton.textContent =
      "Generate Itinerary";
  }
}


// =====================================================
// GPS
// =====================================================

function setGpsStatus(
  message,
  isError = false
) {
  const statusElement =
    document.getElementById(
      "gps-location-status"
    );

  if (!statusElement) {
    return;
  }

  statusElement.textContent =
    message;

  statusElement.style.color =
    isError
      ? "#dc2626"
      : "";
}


function hasCurrentLocationState() {
  return (
    getFormValue(
      "use_current_location"
    ) === "1" &&
    Boolean(
      getFormValue(
        "start_latitude"
      )
    ) &&
    Boolean(
      getFormValue(
        "start_longitude"
      )
    )
  );
}


function updateCurrentLocationUi() {
  const startInput =
    document.getElementById(
      "start"
    );

  const fieldElement =
    document.getElementById(
      "start-location-field"
    );

  const clearButton =
    document.getElementById(
      "clear-current-location-btn"
    );

  const isActive =
    hasCurrentLocationState();


  if (startInput) {
    if (isActive) {
      startInput.value =
        "Current Location";
    }

    startInput.readOnly =
      isActive;
  }


  fieldElement
    ?.classList
    .toggle(
      "current-location-active",
      isActive
    );


  if (clearButton) {
    clearButton.hidden =
      !isActive;
  }
}


function clearCurrentLocation() {
  const startInput =
    document.getElementById(
      "start"
    );

  const latitudeInput =
    document.getElementById(
      "start_latitude"
    );

  const longitudeInput =
    document.getElementById(
      "start_longitude"
    );

  const useCurrentLocationInput =
    document.getElementById(
      "use_current_location"
    );


  if (startInput) {
    startInput.value =
      "";
  }

  if (latitudeInput) {
    latitudeInput.value =
      "";
  }

  if (longitudeInput) {
    longitudeInput.value =
      "";
  }

  if (useCurrentLocationInput) {
    useCurrentLocationInput.value =
      "0";
  }


  setGpsStatus("");

  updateCurrentLocationUi();

  hideLocationSuggestions(
    document.getElementById(
      "start-suggestions"
    )
  );

  persistSmartItineraryState();

  startInput
    ?.focus();
}


function useCurrentLocation() {
  const startInput =
    document.getElementById(
      "start"
    );

  const latitudeInput =
    document.getElementById(
      "start_latitude"
    );

  const longitudeInput =
    document.getElementById(
      "start_longitude"
    );

  const useCurrentLocationInput =
    document.getElementById(
      "use_current_location"
    );

  const gpsButton =
    document.getElementById(
      "use-current-location-btn"
    );


  if (
    !navigator.geolocation
  ) {
    setGpsStatus(
      "GPS is not supported by this browser.",
      true
    );

    return;
  }


  if (gpsButton) {
    gpsButton.disabled =
      true;

    gpsButton.textContent =
      "Detecting location...";
  }


  setGpsStatus(
    "Detecting your current location..."
  );


  navigator.geolocation.getCurrentPosition(

    function (position) {

      const latitude =
        position.coords.latitude;

      const longitude =
        position.coords.longitude;


      if (startInput) {
        startInput.value =
          "Current Location";
      }


      if (latitudeInput) {
        latitudeInput.value =
          String(latitude);
      }


      if (longitudeInput) {
        longitudeInput.value =
          String(longitude);
      }


      if (
        useCurrentLocationInput
      ) {
        useCurrentLocationInput.value =
          "1";
      }


      setGpsStatus(
        `Current location selected (${latitude.toFixed(5)}, ${longitude.toFixed(5)}).`
      );


      updateCurrentLocationUi();


      if (gpsButton) {
        gpsButton.disabled =
          false;

        gpsButton.textContent =
          "Use Current Location";
      }


      persistSmartItineraryState();

    },


    function (error) {

      let message =
        "Unable to get current location.";


      if (
        error.code ===
        error.PERMISSION_DENIED
      ) {
        message =
          "Location permission was denied. Please allow location access or type a start location manually.";

      } else if (
        error.code ===
        error.POSITION_UNAVAILABLE
      ) {
        message =
          "Current location is unavailable. Please type a start location manually.";

      } else if (
        error.code ===
        error.TIMEOUT
      ) {
        message =
          "Location request timed out. Please try again.";
      }


      setGpsStatus(
        message,
        true
      );


      if (gpsButton) {
        gpsButton.disabled =
          false;

        gpsButton.textContent =
          "Use Current Location";
      }

    },


    {
      enableHighAccuracy:
        true,

      timeout:
        12000,

      maximumAge:
        60000
    }
  );
}


function resetGpsWhenStartEdited() {
  const startInput =
    document.getElementById(
      "start"
    );

  const latitudeInput =
    document.getElementById(
      "start_latitude"
    );

  const longitudeInput =
    document.getElementById(
      "start_longitude"
    );

  const useCurrentLocationInput =
    document.getElementById(
      "use_current_location"
    );


  if (!startInput) {
    return;
  }


  startInput.addEventListener(
    "input",
    function () {

      if (
        startInput.value !==
        "Current Location"
      ) {

        if (latitudeInput) {
          latitudeInput.value =
            "";
        }

        if (longitudeInput) {
          longitudeInput.value =
            "";
        }

        if (
          useCurrentLocationInput
        ) {
          useCurrentLocationInput.value =
            "0";
        }

        setGpsStatus("");

        updateCurrentLocationUi();

        persistSmartItineraryState();
      }

    }
  );
}


// =====================================================
// LOCATION AUTOCOMPLETE
// =====================================================

function showLocationSuggestionStatus(
  boxElement,
  message
) {
  if (!boxElement) {
    return;
  }

  boxElement.hidden =
    false;

  boxElement.innerHTML = `
    <div class="location-suggestion-status">
      ${escapeHtml(message)}
    </div>
  `;
}


function showLocationNoResults(
  boxElement
) {
  if (!boxElement) {
    return;
  }

  boxElement.hidden =
    false;

  boxElement.innerHTML = `
    <div class="location-suggestion-status">
      <strong>
        No location found.
      </strong>

      <div style="margin-top:4px;">
        Try a more specific place name,
        nearby landmark,
        road name,
        or postcode.
      </div>
    </div>
  `;
}


function hideLocationSuggestions(
  boxElement
) {
  if (!boxElement) {
    return;
  }

  boxElement.hidden =
    true;

  boxElement.innerHTML =
    "";
}


function suggestionDisplayName(
  suggestion
) {
  return String(
    suggestion.display_name ||
    suggestion.name ||
    suggestion.label ||
    ""
  ).trim();
}


function renderLocationSuggestions(
  inputElement,
  boxElement,
  suggestions
) {

  if (
    !inputElement ||
    !boxElement
  ) {
    return;
  }


  const queryText =
    String(
      inputElement.value || ""
    )
      .trim()
      .toLowerCase();


  let items =
    Array.isArray(
      suggestions
    )
      ? [...suggestions]
      : [];


  function relevanceScore(
    suggestion
  ) {

    const fullName =
      suggestionDisplayName(
        suggestion
      )
        .toLowerCase();


    const explicitName =
      String(
        suggestion.name || ""
      )
        .trim()
        .toLowerCase();


    let score = 0;


    if (
      explicitName ===
      queryText
    ) {
      score += 120;
    }


    if (
      explicitName.startsWith(
        queryText
      )
    ) {
      score += 90;
    }


    if (
      fullName.startsWith(
        queryText
      )
    ) {
      score += 70;
    }


    if (
      fullName.includes(
        queryText
      )
    ) {
      score += 30;
    }


    if (
      fullName.includes(
        "kuala lumpur"
      ) ||
      fullName.includes(
        "selangor"
      ) ||
      fullName.includes(
        "putrajaya"
      )
    ) {
      score += 5;
    }


    return score;
  }


  items.sort(
    (a, b) =>
      relevanceScore(b) -
      relevanceScore(a)
  );


  items =
    items.slice(
      0,
      5
    );


  if (!items.length) {
    showLocationNoResults(
      boxElement
    );

    return;
  }


  boxElement.hidden =
    false;

  boxElement.innerHTML =
    "";


  items.forEach(
    function (suggestion) {

      const button =
        document.createElement(
          "button"
        );

      button.type =
        "button";

      button.className =
        "location-suggestion-item";


      const fullName =
        suggestionDisplayName(
          suggestion
        );


      const parts =
        fullName
          .split(",")
          .map(
            part =>
              part.trim()
          )
          .filter(Boolean);


      const mainName =
        String(
          suggestion.name ||
          parts[0] ||
          fullName ||
          "Location"
        ).trim();


      const subText =
        String(
          suggestion.subtitle ||
          suggestion.address ||
          parts
            .slice(
              mainName === parts[0]
                ? 1
                : 0
            )
            .join(", ")
        ).trim();


      button.innerHTML = `
        <span
          class="location-suggestion-icon"
        >
          📍
        </span>

        <span
          class="location-suggestion-main"
        >
          <span
            class="location-suggestion-name"
          >
            ${escapeHtml(mainName)}
          </span>

          ${
            subText
              ? `
                <span
                  class="location-suggestion-sub"
                >
                  ${escapeHtml(subText)}
                </span>
              `
              : ""
          }
        </span>
      `;


      button.addEventListener(
        "mousedown",
        function (event) {

          event.preventDefault();


          inputElement.value =
            fullName ||
            mainName;


          hideLocationSuggestions(
            boxElement
          );


          if (
            inputElement.id ===
            "start"
          ) {

            const useCurrentLocationInput =
              document.getElementById(
                "use_current_location"
              );

            const latitudeInput =
              document.getElementById(
                "start_latitude"
              );

            const longitudeInput =
              document.getElementById(
                "start_longitude"
              );


            if (
              useCurrentLocationInput
            ) {
              useCurrentLocationInput.value =
                "0";
            }


            if (latitudeInput) {
              latitudeInput.value =
                "";
            }


            if (longitudeInput) {
              longitudeInput.value =
                "";
            }


            setGpsStatus("");

            updateCurrentLocationUi();
          }


          persistSmartItineraryState();

        }
      );


      boxElement.appendChild(
        button
      );

    }
  );
}


function setupLocationAutocomplete(
  inputId,
  suggestionsId
) {

  const inputElement =
    document.getElementById(
      inputId
    );

  const boxElement =
    document.getElementById(
      suggestionsId
    );


  if (
    !inputElement ||
    !boxElement
  ) {
    return;
  }


  let debounceTimer = null;
  let latestQuery = "";


  inputElement.addEventListener(
    "input",
    function () {

      const queryText =
        inputElement.value
          .trim();


      latestQuery =
        queryText;


      if (debounceTimer) {
        clearTimeout(
          debounceTimer
        );
      }


      if (
        queryText.length < 3 ||
        queryText ===
        "Current Location"
      ) {

        hideLocationSuggestions(
          boxElement
        );

        return;
      }


      showLocationSuggestionStatus(
        boxElement,
        "Searching locations..."
      );


      debounceTimer =
        setTimeout(

          async function () {

            try {

              const response =
                await fetch(
                  `/api/location-suggestions?q=${encodeURIComponent(queryText)}`,
                  {
                    method:
                      "GET",

                    headers: {
                      Accept:
                        "application/json"
                    }
                  }
                );


              if (!response.ok) {
                throw new Error(
                  `Location suggestion request failed: ${response.status}`
                );
              }


              const data =
                await response.json();


              if (
                latestQuery !==
                inputElement.value.trim()
              ) {
                return;
              }


              renderLocationSuggestions(
                inputElement,
                boxElement,
                data.suggestions || []
              );


            } catch (error) {

              console.error(
                "Location suggestion error:",
                error
              );


              if (
                latestQuery !==
                inputElement.value.trim()
              ) {
                return;
              }


              showLocationSuggestionStatus(
                boxElement,
                "Unable to load locations. Please try again."
              );

            }

          },

          500
        );

    }
  );


  inputElement.addEventListener(
    "focus",
    function () {

      const queryText =
        inputElement.value
          .trim();


      if (
        queryText.length >= 3 &&
        boxElement.innerHTML.trim()
      ) {
        boxElement.hidden =
          false;
      }

    }
  );


  inputElement.addEventListener(
    "blur",
    function () {

      setTimeout(
        function () {
          hideLocationSuggestions(
            boxElement
          );
        },
        180
      );

    }
  );
}


// =====================================================
// FAVOURITES
// =====================================================

function favouritesCacheKey(
  user
) {
  return (
    FAVOURITES_CACHE_PREFIX +
    user.uid
  );
}


function restoreFavouritePlacesFromLocalStorage(
  user
) {
  try {

    const cached =
      JSON.parse(
        localStorage.getItem(
          favouritesCacheKey(
            user
          )
        ) ||
        "[]"
      );


    if (
      !Array.isArray(
        cached
      )
    ) {
      return false;
    }


    favouritePlaces =
      cached;


    return (
      cached.length > 0
    );


  } catch {

    localStorage.removeItem(
      favouritesCacheKey(
        user
      )
    );

    return false;
  }
}


function saveFavouritePlacesToLocalStorage(
  user
) {
  if (!user) {
    return;
  }

  try {

    localStorage.setItem(
      favouritesCacheKey(
        user
      ),

      JSON.stringify(
        favouritePlaces
      )
    );

  } catch {
    // Firestore is still source of truth.
  }
}


function normaliseFavouritePlace(
  docSnap
) {
  const data =
    docSnap.data();

  return {
    id:
      docSnap.id,

    place_id:
      docSnap.id,

    name:
      data.name ||
      "Unnamed Favourite",

    area:
      data.area ||
      "",

    category:
      data.category ||
      "Favourite",

    latitude:
      Number(
        data.latitude ||
        0
      ),

    longitude:
      Number(
        data.longitude ||
        0
      ),

    rating:
      Number(
        data.rating ||
        0
      ),

    image_url:
      data.image_url ||
      "",

    source:
      "Favourites",

    is_favourite:
      true
  };
}


async function loadFavouritePlaces(
  user
) {

  const loadingElement =
    document.getElementById(
      "favourites-loading"
    );


  const favouriteQuery =
    query(
      collection(
        db,
        FAVOURITES_COLLECTION
      ),

      where(
        "user_id",
        "==",
        user.uid
      )
    );


  const snapshot =
    await getDocs(
      favouriteQuery
    );


  favouritePlaces =
    [];


  snapshot.forEach(
    function (docSnap) {
      favouritePlaces.push(
        normaliseFavouritePlace(
          docSnap
        )
      );
    }
  );


  saveFavouritePlacesToLocalStorage(
    user
  );


  if (loadingElement) {
    loadingElement.style.display =
      "none";
  }


  renderFavouritePlaces();
}


function renderFavouriteError() {
  const loadingElement =
    document.getElementById(
      "favourites-loading"
    );

  if (loadingElement) {
    loadingElement.textContent =
      "Unable to load favourite places.";
  }
}


function getMaxStopsValue() {
  const maxStopsSelect =
    document.getElementById(
      "max_stops"
    );

  return maxStopsSelect
    ? Number(
        maxStopsSelect.value ||
        1
      )
    : 1;
}


function getSelectedFavouriteIds() {
  return Array.from(
    document.querySelectorAll(
      ".js-favourite-place:checked"
    )
  ).map(
    checkbox =>
      checkbox.value
  );
}


function getSelectedFavouritePlaces() {
  const selectedIds =
    getSelectedFavouriteIds();

  return selectedIds
    .map(
      id =>
        favouritePlaces.find(
          place =>
            place.id ===
            id
        )
    )
    .filter(Boolean);
}


function updateSelectedFavouritesHidden() {
  const hiddenInput =
    document.getElementById(
      "selected_favourites_json"
    );

  if (!hiddenInput) {
    return;
  }

  hiddenInput.value =
    JSON.stringify(
      getSelectedFavouritePlaces()
    );
}


function getFilteredFavouritePlaces() {
  const keyword =
    favouriteSearchText
      .trim()
      .toLowerCase();

  if (!keyword) {
    return favouritePlaces;
  }

  return favouritePlaces.filter(
    place =>
      String(
        place.name || ""
      )
        .toLowerCase()
        .includes(
          keyword
        )
      ||
      String(
        place.category || ""
      )
        .toLowerCase()
        .includes(
          keyword
        )
      ||
      String(
        place.area || ""
      )
        .toLowerCase()
        .includes(
          keyword
        )
  );
}


function enforceFavouriteLimit() {
  const maxStops =
    getMaxStopsValue();

  const selectedIds =
    getSelectedFavouriteIds();

  const checkboxes =
    document.querySelectorAll(
      ".js-favourite-place"
    );

  const helperText =
    document.getElementById(
      "favourite-helper-text"
    );


  checkboxes.forEach(
    function (checkbox) {
      checkbox.disabled =
        !checkbox.checked &&
        selectedIds.length >=
          maxStops;
    }
  );


  if (helperText) {
    helperText.textContent =
      `Select up to ${maxStops} favourite place${maxStops > 1 ? "s" : ""}. Selected favourites will use the available stop slots.`;
  }


  updateSelectedFavouritesHidden();
}


function renderFavouritePlaces() {
  const listElement =
    document.getElementById(
      "favourites-list"
    );

  if (!listElement) {
    return;
  }


  if (!favouritePlaces.length) {
    listElement.innerHTML = `
      <div class="favourite-place-meta">
        No favourite places found.
        Add favourites from the Attractions page first.
      </div>
    `;

    return;
  }


  const filteredFavouritePlaces =
    getFilteredFavouritePlaces();


  if (
    !filteredFavouritePlaces.length
  ) {
    listElement.innerHTML = `
      <div class="favourite-place-meta">
        No favourite place matched your search.
      </div>
    `;

    return;
  }


  listElement.innerHTML =
    "";


  filteredFavouritePlaces.forEach(
    function (place) {

      const label =
        document.createElement(
          "label"
        );

      label.className =
        "favourite-place-option";


      label.innerHTML = `
        <input
          type="checkbox"
          class="js-favourite-place"
          value="${escapeHtml(place.id)}"
        >

        <span>
          <span
            class="favourite-place-name"
          >
            ${escapeHtml(place.name)}
          </span>

          <br>

          <span
            class="favourite-place-meta"
          >
            ${escapeHtml(
              attractionCategory(
                place
              )
            )}

            ${
              place.rating
                ? ` · ★ ${Number(place.rating).toFixed(1)}`
                : ""
            }

            ${
              place.area
                ? `<br>${escapeHtml(place.area)}`
                : ""
            }
          </span>
        </span>
      `;


      const checkbox =
        label.querySelector(
          ".js-favourite-place"
        );


      checkbox.addEventListener(
        "change",
        function () {

          const maxStops =
            getMaxStopsValue();


          const selectedCount =
            getSelectedFavouriteIds()
              .length;


          if (
            selectedCount >
            maxStops
          ) {

            checkbox.checked =
              false;


            openPlannerAlertModal(
              "Favourite Limit Reached",
              `You can only select up to ${maxStops} favourite place${maxStops > 1 ? "s" : ""}.`
            );
          }


          enforceFavouriteLimit();

          persistSmartItineraryState();
        }
      );


      listElement.appendChild(
        label
      );
    }
  );


  restoreSelectedFavouritesFromHidden();

  enforceFavouriteLimit();
}


function restoreSelectedFavouritesFromHidden() {
  const hiddenInput =
    document.getElementById(
      "selected_favourites_json"
    );

  if (
    !hiddenInput ||
    !hiddenInput.value
  ) {
    return;
  }

  try {

    const selected =
      JSON.parse(
        hiddenInput.value
      );


    const selectedIds =
      selected.map(
        place =>
          place.id ||
          place.place_id
      );


    selectedIds.forEach(
      function (id) {

        const checkbox =
          document.querySelector(
            `.js-favourite-place[value="${escapeCssValue(id)}"]`
          );


        if (checkbox) {
          checkbox.checked =
            true;
        }

      }
    );


  } catch (error) {

    console.warn(
      "Unable to restore selected favourites:",
      error
    );

  }
}


// =====================================================
// REMOVE STOP / REGENERATE
// =====================================================

function getExcludedStopNames() {
  const hiddenInput =
    document.getElementById(
      "excluded_stop_names"
    );

  if (
    !hiddenInput ||
    !hiddenInput.value
  ) {
    return [];
  }

  try {

    const names =
      JSON.parse(
        hiddenInput.value
      );

    return Array.isArray(names)
      ? names
      : [];

  } catch {
    return [];
  }
}


function setExcludedStopNames(names) {
  const hiddenInput =
    document.getElementById(
      "excluded_stop_names"
    );

  if (hiddenInput) {
    hiddenInput.value =
      JSON.stringify(names);
  }
}


function setRegenerateToken() {
  const tokenInput =
    document.getElementById(
      "regenerate_token"
    );

  if (tokenInput) {
    tokenInput.value =
      String(
        Date.now()
      );
  }
}


function validateFavouriteSelection() {
  const maxStops =
    getMaxStopsValue();

  const selectedCount =
    getSelectedFavouriteIds()
      .length;

  if (
    selectedCount >
    maxStops
  ) {
    openPlannerAlertModal(
      "Favourite Limit Exceeded",
      `Selected favourite places cannot exceed maximum stops (${maxStops}).`
    );

    return false;
  }

  updateSelectedFavouritesHidden();

  return true;
}


function validateInterestSelection() {
  const selectedInterests =
    getSelectedInterests();

  if (
    !selectedInterests.length
  ) {
    openPlannerAlertModal(
      "Travel Interest Required",
      "Please select at least one travel interest before generating the itinerary."
    );

    return false;
  }

  return true;
}


function submitPlannerForm(
  loadingText =
    "Generating itinerary..."
) {
  const itineraryForm =
    document.getElementById(
      "itinerary-form"
    );

  if (!itineraryForm) {
    return;
  }

  if (
    !validateTripDateTime()
  ) {
    return;
  }

  if (
    !validateFavouriteSelection()
  ) {
    return;
  }

  if (
    !validateInterestSelection()
  ) {
    return;
  }

  showPlannerLoading(
    loadingText
  );

  if (
    itineraryForm.requestSubmit
  ) {
    itineraryForm.requestSubmit();
  } else {
    itineraryForm.submit();
  }
}


function removeStopAndRefresh(
  stopName
) {
  const names =
    getExcludedStopNames();

  if (
    !names.includes(
      stopName
    )
  ) {
    names.push(
      stopName
    );
  }

  setExcludedStopNames(
    names
  );

  setRegenerateToken();

  submitPlannerForm(
    "Updating route..."
  );
}


// =====================================================
// DATE / TIME
// =====================================================

function getTodayDateKey() {
  const now =
    new Date();

  const year =
    now.getFullYear();

  const month =
    String(
      now.getMonth() + 1
    )
      .padStart(
        2,
        "0"
      );

  const day =
    String(
      now.getDate()
    )
      .padStart(
        2,
        "0"
      );

  return `${year}-${month}-${day}`;
}


function getCurrentTimeKey() {
  const now =
    new Date();

  const hour =
    String(
      now.getHours()
    )
      .padStart(
        2,
        "0"
      );

  const minute =
    String(
      now.getMinutes()
    )
      .padStart(
        2,
        "0"
      );

  return `${hour}:${minute}`;
}


function updateDateTimeLimits() {
  const tripDateInput =
    document.getElementById(
      "trip_date"
    );

  const startTimeInput =
    document.getElementById(
      "start_time"
    );

  if (
    !tripDateInput ||
    !startTimeInput
  ) {
    return;
  }

  const today =
    getTodayDateKey();

  tripDateInput.min =
    today;

  if (
    tripDateInput.value &&
    tripDateInput.value <
      today
  ) {
    tripDateInput.value =
      today;
  }

  if (
    tripDateInput.value ===
    today
  ) {
    startTimeInput.min =
      getCurrentTimeKey();
  } else {
    startTimeInput.removeAttribute(
      "min"
    );
  }
}


function validateTripDateTime() {
  const tripDateInput =
    document.getElementById(
      "trip_date"
    );

  const startTimeInput =
    document.getElementById(
      "start_time"
    );

  if (
    !tripDateInput ||
    !startTimeInput
  ) {
    return true;
  }

  const today =
    getTodayDateKey();

  const currentTime =
    getCurrentTimeKey();


  if (
    tripDateInput.value <
    today
  ) {
    openPlannerAlertModal(
      "Invalid Travel Date",
      "Travel date cannot be before today."
    );

    tripDateInput.value =
      today;

    return false;
  }


  if (
    tripDateInput.value ===
      today &&
    startTimeInput.value <
      currentTime
  ) {

    openPlannerAlertModal(
      "Invalid Start Time",
      "Start time cannot be earlier than the current time."
    );

    startTimeInput.value =
      currentTime;

    return false;
  }


  return true;
}


// =====================================================
// SESSION STATE
// =====================================================

function readSessionState(key) {
  try {
    return JSON.parse(
      sessionStorage.getItem(
        key
      ) ||
      "null"
    );
  } catch {
    sessionStorage.removeItem(
      key
    );

    return null;
  }
}


function writeSessionState(
  key,
  value
) {
  try {
    sessionStorage.setItem(
      key,
      JSON.stringify(value)
    );
  } catch {
    // Ignore storage failure.
  }
}


function getCheckedValues(
  selector
) {
  return Array.from(
    document.querySelectorAll(
      selector
    )
  )
    .filter(
      input =>
        input.checked
    )
    .map(
      input =>
        input.value
    );
}


function setCheckedValues(
  selector,
  values
) {
  const selected =
    new Set(
      Array.isArray(values)
        ? values
        : []
    );

  document
    .querySelectorAll(
      selector
    )
    .forEach(
      function (input) {

        input.checked =
          selected.has(
            input.value
          );

        input
          .closest(
            ".interest-chip"
          )
          ?.classList
          .toggle(
            "active",
            input.checked
          );
      }
    );
}


function ensureJsonScript(
  id,
  payload
) {
  if (
    !payload
  ) {
    return;
  }

  let script =
    document.getElementById(
      id
    );

  if (!script) {
    script =
      document.createElement(
        "script"
      );

    script.id =
      id;

    script.type =
      "application/json";

    document.body.appendChild(
      script
    );
  }

  script.textContent =
    JSON.stringify(
      payload
    );
}


function clearRuntimeBindingFlags(
  root
) {
  if (!root) {
    return;
  }

  const clearElement =
    element => {
      if (
        !element ||
        !element.removeAttribute
      ) {
        return;
      }

      RUNTIME_BINDING_ATTRIBUTES
        .forEach(
          attribute =>
            element.removeAttribute(
              attribute
            )
        );
    };

  clearElement(
    root
  );

  root
    .querySelectorAll(
      RUNTIME_BINDING_ATTRIBUTES
        .map(
          attribute =>
            `[${attribute}]`
        )
        .join(",")
    )
    .forEach(
      clearElement
    );
}


function getCleanResultHtml(
  resultColumn
) {
  if (!resultColumn) {
    return "";
  }

  const clone =
    resultColumn.cloneNode(
      true
    );

  clearRuntimeBindingFlags(
    clone
  );

  return clone.innerHTML;
}


function collectSmartItineraryState() {
  const resultColumn =
    document.querySelector(
      ".itinerary-result-col"
    );

  const plan =
    getJsonData(
      "plan-data"
    );

  const mapData =
    getJsonData(
      "map-data"
    );

  return {
    form: {
      start:
        getFormValue(
          "start"
        ),

      use_current_location:
        getFormValue(
          "use_current_location"
        ),

      start_latitude:
        getFormValue(
          "start_latitude"
        ),

      start_longitude:
        getFormValue(
          "start_longitude"
        ),

      end:
        getFormValue(
          "end"
        ),

      trip_date:
        getFormValue(
          "trip_date"
        ),

      start_time:
        getFormValue(
          "start_time"
        ),

      available_hours:
        getFormValue(
          "available_hours"
        ),

      max_stops:
        getFormValue(
          "max_stops"
        ),

      minimum_rating:
        getFormValue(
          "minimum_rating"
        ),

      interests:
        getCheckedValues(
          'input[name="interests"]'
        )
    },

    resultHtml:
      plan &&
      mapData &&
      resultColumn
        ? getCleanResultHtml(
            resultColumn
          )
        : "",

    plan:
      plan,

    mapData:
      mapData,

    savedAt:
      Date.now()
  };
}


function persistSmartItineraryState() {
  if (
    itineraryStateClearedForHandoff
  ) {
    return;
  }

  writeSessionState(
    ITINERARY_STATE_KEY,
    collectSmartItineraryState()
  );
}


function clearSmartItineraryState() {
  itineraryStateClearedForHandoff =
    true;

  sessionStorage.removeItem(
    ITINERARY_STATE_KEY
  );
}


function replaceGeneratedPostWithGet() {
  const postRenderData =
    getJsonData(
      "planner-post-render-data"
    ) ||
    {};

  if (
    !postRenderData.generated_from_post
  ) {
    return false;
  }

  if (
    !getJsonData(
      "plan-data"
    ) ||
    !getJsonData(
      "map-data"
    )
  ) {
    return false;
  }

  persistSmartItineraryState();

  window.location.replace(
    postRenderData.planner_url ||
    window.location.pathname
  );

  return true;
}


function restoreSmartItineraryState() {
  const state =
    readSessionState(
      ITINERARY_STATE_KEY
    );

  if (
    !state ||
    !state.form
  ) {
    return false;
  }


  Object.entries(
    state.form
  )
    .forEach(
      function (
        [id, value]
      ) {

        if (
          id ===
          "interests"
        ) {
          return;
        }


        const element =
          document.getElementById(
            id
          );


        if (
          element &&
          value !== undefined &&
          value !== null
        ) {
          element.value =
            value;
        }
      }
    );


  setCheckedValues(
    'input[name="interests"]',
    state.form.interests
  );


  updateCurrentLocationUi();


  updateMaximumStopsOptions();


  const resultColumn =
    document.querySelector(
      ".itinerary-result-col"
    );


  const hasServerPlan =
    Boolean(
      document.getElementById(
        "plan-data"
      )
    );


  if (
    !hasServerPlan &&
    resultColumn &&
    state.resultHtml &&
    state.plan &&
    state.mapData
  ) {

    ensureJsonScript(
      "plan-data",
      state.plan
    );


    ensureJsonScript(
      "map-data",
      state.mapData
    );

    resultColumn.innerHTML =
      state.resultHtml;

    clearRuntimeBindingFlags(
      resultColumn
    );


    return true;
  }


  return false;
}


// =====================================================
// MAP
// =====================================================

function initRouteMap() {
  const mapDataElement =
    document.getElementById(
      "map-data"
    );

  const routeMapElement =
    document.getElementById(
      "routeMap"
    );

  if (
    !mapDataElement ||
    !routeMapElement ||
    typeof L ===
      "undefined"
  ) {
    return;
  }


  if (
    routeMapElement.dataset
      .mapInitialised ===
    "1"
  ) {
    return;
  }


  let mapData;

  try {
    mapData =
      JSON.parse(
        mapDataElement.textContent
      );
  } catch (error) {
    console.error(
      "Invalid map data:",
      error
    );

    return;
  }


  const startPoint =
    mapData.start;

  const endPoint =
    mapData.end;

  const attractions =
    mapData.attractions ||
    [];

  const routeGeometry =
    mapData.routeGeometry;


  if (
    !startPoint ||
    !endPoint
  ) {
    return;
  }


  routeMapElement.dataset
    .mapInitialised =
    "1";


  const map =
    L.map(
      "routeMap"
    )
      .setView(
        [
          startPoint.latitude,
          startPoint.longitude
        ],
        13
      );


  L.tileLayer(
    "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    {
      maxZoom:
        19,

      attribution:
        ""
    }
  )
    .addTo(
      map
    );


  const markerGroup =
    L.featureGroup();


  const startMarker =
    L.marker([
      startPoint.latitude,
      startPoint.longitude
    ])
      .bindPopup(
        "Start: " +
        (
          mapData.startDisplayText ||
          shortLocationName(
            mapData.startText
          )
        )
      )
      .addTo(
        map
      );


  markerGroup.addLayer(
    startMarker
  );


  attractions.forEach(
    function (
      place,
      index
    ) {

      const marker =
        L.marker([
          place.latitude,
          place.longitude
        ])
          .bindPopup(
            `${index + 1}. ${place.name}`
          )
          .addTo(
            map
          );


      markerGroup.addLayer(
        marker
      );
    }
  );


  const endMarker =
    L.marker([
      endPoint.latitude,
      endPoint.longitude
    ])
      .bindPopup(
        "End: " +
        (
          mapData.endDisplayText ||
          shortLocationName(
            mapData.endText
          )
        )
      )
      .addTo(
        map
      );


  markerGroup.addLayer(
    endMarker
  );


  if (routeGeometry) {

    const routeLayer =
      L.geoJSON(
        routeGeometry
      )
        .addTo(
          map
        );


    map.fitBounds(
      routeLayer.getBounds(),
      {
        padding:
          [24, 24]
      }
    );

  } else {

    map.fitBounds(
      markerGroup.getBounds(),
      {
        padding:
          [24, 24]
      }
    );
  }
}


function loadLeafletForRestoredRoute() {
  if (
    !document.getElementById(
      "routeMap"
    )
  ) {
    return;
  }


  if (
    typeof L !==
    "undefined"
  ) {
    initRouteMap();
    return;
  }


  if (
    !document.querySelector(
      'link[href*="leaflet.css"]'
    )
  ) {
    const link =
      document.createElement(
        "link"
      );

    link.rel =
      "stylesheet";

    link.href =
      "https://unpkg.com/leaflet/dist/leaflet.css";

    document.head.appendChild(
      link
    );
  }


  if (
    document.querySelector(
      'script[src*="leaflet"]'
    )
  ) {
    document
      .querySelector(
        'script[src*="leaflet"]'
      )
      ?.addEventListener(
        "load",
        initRouteMap,
        {
          once:
            true
        }
      );

    return;
  }


  const script =
    document.createElement(
      "script"
    );

  script.src =
    "https://unpkg.com/leaflet/dist/leaflet.js";

  script.addEventListener(
    "load",
    initRouteMap
  );

  document.body.appendChild(
    script
  );
}


// =====================================================
// DETAIL MODAL
// =====================================================

function resetItineraryPlaceDetailModal() {
  const roleElement =
    document.getElementById(
      "itinerary-route-role"
    );

  const titleElement =
    document.getElementById(
      "itinerary-detail-title"
    );

  const locationElement =
    document.getElementById(
      "itinerary-detail-location-main"
    );

  const categoryElement =
    document.getElementById(
      "itinerary-detail-category"
    );

  const ratingElement =
    document.getElementById(
      "itinerary-detail-rating"
    );

  const categoryCell =
    document.getElementById(
      "itinerary-detail-category-cell"
    );

  const ratingCell =
    document.getElementById(
      "itinerary-detail-rating-cell"
    );

  const favouriteBadge =
    document.getElementById(
      "itinerary-detail-favourite-badge"
    );

  const factsRow =
    document.getElementById(
      "itinerary-detail-facts"
    );

  const durationCell =
    document.getElementById(
      "itinerary-detail-duration-cell"
    );

  const durationElement =
    document.getElementById(
      "itinerary-detail-duration"
    );

  const descriptionElement =
    document.getElementById(
      "itinerary-detail-description"
    );

  const interestsElement =
    document.getElementById(
      "itinerary-detail-interests"
    );

  const reasonsElement =
    document.getElementById(
      "itinerary-detail-reasons"
    );


  if (roleElement) {
    roleElement.textContent =
      "";

    roleElement.hidden =
      true;
  }


  if (titleElement) {
    titleElement.textContent =
      "";
  }


  if (locationElement) {
    locationElement.textContent =
      "";

    locationElement.hidden =
      true;
  }


  if (categoryElement) {
    categoryElement.textContent =
      "";

    categoryElement.hidden =
      true;
  }


  if (ratingElement) {
    ratingElement.textContent =
      "";

    ratingElement.hidden =
      true;
  }


  if (favouriteBadge) {
    favouriteBadge.hidden =
      true;
  }


  if (factsRow) {
    factsRow.hidden =
      true;
  }


  if (durationCell) {
    durationCell.hidden =
      true;
  }


  if (categoryCell) {
    categoryCell.hidden =
      true;
  }


  if (ratingCell) {
    ratingCell.hidden =
      true;
  }


  if (durationElement) {
    durationElement.textContent =
      "";
  }


  if (descriptionElement) {
    descriptionElement.textContent =
      "";
  }


  if (interestsElement) {
    interestsElement.innerHTML =
      "";
  }


  if (reasonsElement) {
    reasonsElement.innerHTML =
      "";
  }


  setSectionVisibility(
    "itinerary-detail-about-section",
    false
  );


  setSectionVisibility(
    "itinerary-detail-interests-section",
    false
  );


  setSectionVisibility(
    "itinerary-detail-reasons-section",
    false
  );
}


function setItineraryDetailImage(
  imageUrl
) {

  const imageElement =
    document.getElementById(
      "itinerary-detail-image"
    );


  const headerElement =
    imageElement?.closest(
      ".detail-header"
    );


  if (
    !imageElement ||
    !headerElement
  ) {
    return;
  }


  headerElement.hidden =
    false;


  imageElement.hidden =
    false;


  imageElement.onerror =
    null;


  imageElement.src =
    imageUrl ||
    ITINERARY_PLACEHOLDER_IMAGE;


  imageElement.onerror =
    function () {

      imageElement.onerror =
        null;


      imageElement.src =
        ITINERARY_PLACEHOLDER_IMAGE;

    };
}


async function openItineraryPlaceDetail(
  kind,
  index = -1
) {

  const plan =
    getJsonData(
      "plan-data"
    );


  const mapData =
    getJsonData(
      "map-data"
    );


  const modal =
    document.getElementById(
      "itinerary-attraction-modal"
    );


  if (
    !plan ||
    !modal
  ) {
    return;
  }


  resetItineraryPlaceDetailModal();


  const placeKind =
    kind === "start" ||
    kind === "end"
      ? kind
      : "attraction";


  const isRouteLocation =
    placeKind === "start" ||
    placeKind === "end";


  let detail;


  if (
    placeKind ===
    "start"
  ) {

    const fullAddress =
      plan.start_text ||
      mapData?.startText ||
      getFormValue(
        "start"
      ) ||
      "";

    const startLocation =
      plan.start ||
      mapData?.start ||
      {};

    const startResolvedName =
      String(
        startLocation.resolved_name ||
        ""
      )
        .trim();

    const startWasSnapped =
      Boolean(
        startLocation.route_start_snapped &&
        startResolvedName
      );


    detail = {
      name:
        startWasSnapped
          ? `Near ${startResolvedName}`
          : (
              plan.start_display_text ||
              mapData?.startDisplayText ||
              shortLocationName(
                fullAddress
              ) ||
              "Start Location"
            ),

      address:
        startWasSnapped
          ? "Selected from Current Location"
          : startResolvedName
          ? `Near ${startResolvedName}`
          : fullAddress,

      role:
        "Start Location"
    };


  } else if (
    placeKind ===
    "end"
  ) {

    const fullAddress =
      plan.end_text ||
      mapData?.endText ||
      getFormValue(
        "end"
      ) ||
      "";

    const endLocation =
      plan.end ||
      mapData?.end ||
      {};

    const endResolvedName =
      String(
        endLocation.resolved_name ||
        ""
      )
        .trim();

    const endIsApproximate =
      Boolean(
        endLocation.is_approximate &&
        endLocation.location_source ===
          "serpapi" &&
        endResolvedName
      );


    detail = {
      name:
        endIsApproximate
          ? `Near ${endResolvedName}`
          : (
              plan.end_display_text ||
              mapData?.endDisplayText ||
              shortLocationName(
                fullAddress
              ) ||
              "End Location"
            ),

      address:
        fullAddress,

      role:
        "End Location"
    };


  } else {

    detail =
      plan?.selected?.[
        index
      ];


    if (!detail) {
      return;
    }
  }


  const roleElement =
    document.getElementById(
      "itinerary-route-role"
    );

  const titleElement =
    document.getElementById(
      "itinerary-detail-title"
    );

  const locationElement =
    document.getElementById(
      "itinerary-detail-location-main"
    );

  const categoryElement =
    document.getElementById(
      "itinerary-detail-category"
    );

  const ratingElement =
    document.getElementById(
      "itinerary-detail-rating"
    );

  const categoryCell =
    document.getElementById(
      "itinerary-detail-category-cell"
    );

  const ratingCell =
    document.getElementById(
      "itinerary-detail-rating-cell"
    );

  const favouriteBadge =
    document.getElementById(
      "itinerary-detail-favourite-badge"
    );

  const factsRow =
    document.getElementById(
      "itinerary-detail-facts"
    );

  const durationCell =
    document.getElementById(
      "itinerary-detail-duration-cell"
    );

  const durationElement =
    document.getElementById(
      "itinerary-detail-duration"
    );

  const descriptionElement =
    document.getElementById(
      "itinerary-detail-description"
    );

  const interestsElement =
    document.getElementById(
      "itinerary-detail-interests"
    );

  const reasonsElement =
    document.getElementById(
      "itinerary-detail-reasons"
    );


  let detailImageUrl =
    getAttractionImage(
      detail
    );


  if (
    isRouteLocation
  ) {
    detailImageUrl =
      await getPlaceDetailPhoto(
        detail.address ||
        detail.name
      );

  } else if (
    !detailImageUrl
  ) {
    detailImageUrl =
      await getPlaceDetailPhoto(
        detail.name ||
        detail.address ||
        detail.area ||
        detail.location
      );
  }


  setItineraryDetailImage(
    detailImageUrl
  );


  if (titleElement) {
    titleElement.textContent =
      detail.name ||
      "Place";
  }


  const fullLocation =
    detail.address ||
    detail.area ||
    detail.location ||
    "";


  if (locationElement) {
    locationElement.textContent =
      fullLocation;

    locationElement.hidden =
      !hasUsableDetailText(
        fullLocation
      );
  }


  if (
    isRouteLocation
  ) {

    if (roleElement) {
      roleElement.textContent =
        detail.role;

      roleElement.hidden =
        false;
    }


    if (categoryElement) {
      categoryElement.textContent =
        "";

      categoryElement.hidden =
        true;
    }


    if (ratingElement) {
      ratingElement.textContent =
        "";

      ratingElement.hidden =
        true;
    }


    if (categoryCell) {
      categoryCell.hidden =
        true;
    }


    if (ratingCell) {
      ratingCell.hidden =
        true;
    }


    if (favouriteBadge) {
      favouriteBadge.hidden =
        true;
    }


    if (factsRow) {
      factsRow.hidden =
        true;
    }


  } else {

    const category =
      attractionCategory(
        detail
      );


    const hasCategory =
      Boolean(
        category
      );


    if (categoryElement) {
      categoryElement.textContent =
        category;

      categoryElement.hidden =
        !hasCategory;
    }


    if (categoryCell) {
      categoryCell.hidden =
        !hasCategory;
    }


    const rating =
      Number(
        detail.rating ||
        0
      );


    const hasRating =
      Number.isFinite(rating) &&
      rating > 0;


    if (ratingElement) {

      if (
        hasRating
      ) {

        ratingElement.innerHTML =
          `&#9733; ${rating.toFixed(1)}`;

        ratingElement.hidden =
          false;

      } else {

        ratingElement.textContent =
          "";

        ratingElement.hidden =
          true;
      }
    }


    if (ratingCell) {
      ratingCell.hidden =
        !hasRating;
    }


    const isFavourite =
      detail.is_favourite ===
        true ||
      String(
        detail.source ||
        ""
      )
        .toLowerCase()
        .includes(
          "favourite"
        );


    if (favouriteBadge) {
      favouriteBadge.hidden =
        !isFavourite;
    }


    const visitMinutes =
      Number(
        detail.estimated_minutes ||
        0
      );


    const hasVisitMinutes =
      Number.isFinite(
        visitMinutes
      ) &&
      visitMinutes >
        0;


    if (
      hasVisitMinutes
    ) {

      if (durationElement) {
        durationElement.textContent =
          `${Math.round(visitMinutes)} mins`;
      }


      if (durationCell) {
        durationCell.hidden =
          false;
      }

    }


    if (factsRow) {
      factsRow.hidden =
        !(
          hasVisitMinutes ||
          hasCategory ||
          hasRating
        );
    }


    const descriptionText =
      getAttractionAboutDescription(
        detail
      );

    if (descriptionElement) {
      descriptionElement.textContent =
        descriptionText;
    }


    setSectionVisibility(
      "itinerary-detail-about-section",
      Boolean(
        descriptionText
      )
    );


    const rawInterests =
      detail.matched_interests ||
      detail.interest_tags ||
      detail.interests ||
      detail.tags ||
      [];


    const interests =
      getDetailList(
        rawInterests
      )
        .filter(
          value =>
            ![
              "favourite",
              "attraction",
              "tourist attraction"
            ].includes(
              value.toLowerCase()
            )
        );


    if (interestsElement) {

      interestsElement.innerHTML =
        interests
          .map(
            interest => `
              <span
                class="detail-pill"
              >
                ${escapeHtml(
                  formatCategoryLabel(
                    interest
                  )
                )}
              </span>
            `
          )
          .join("");
    }


    setSectionVisibility(
      "itinerary-detail-interests-section",
      interests.length > 0
    );


    const reasons =
      getUserFacingRecommendationReasons(
        detail
      );


    if (reasonsElement) {
      reasonsElement.innerHTML =
        reasons
          .map(
            reason => `
              <span
                class="detail-pill"
              >
                ${escapeHtml(reason)}
              </span>
            `
          )
          .join("");
    }


    setSectionVisibility(
      "itinerary-detail-reasons-section",
      reasons.length > 0
    );
  }


  modal.classList.add(
    "show"
  );


  modal.setAttribute(
    "aria-hidden",
    "false"
  );


  document.body.style.overflow =
    "hidden";
}


function closeItineraryAttractionDetail() {
  const modal =
    document.getElementById(
      "itinerary-attraction-modal"
    );

  if (!modal) {
    return;
  }

  modal.classList.remove(
    "show"
  );

  modal.setAttribute(
    "aria-hidden",
    "true"
  );

  document.body.style.overflow =
    "";
}


function bindPlaceDetailButtons() {
  document
    .querySelectorAll(
      ".js-open-place-detail"
    )
    .forEach(
      function (button) {

        if (
          button.dataset.detailBound ===
          "1"
        ) {
          return;
        }


        button.dataset.detailBound =
          "1";


        button.addEventListener(
          "click",
          function () {

            openItineraryPlaceDetail(
              button.dataset.placeKind ||
              "attraction",

              Number(
                button.dataset.attractionIndex ||
                -1
              )
            )
              .catch(
                console.error
              );
          }
        );

      }
    );
}


function bindRemoveStopButtons() {
  document
    .querySelectorAll(
      ".js-remove-stop"
    )
    .forEach(
      function (button) {

        if (
          button.dataset.removeBound ===
          "1"
        ) {
          return;
        }


        button.dataset.removeBound =
          "1";


        button.addEventListener(
          "click",
          function () {

            const stopName =
              button.dataset.stopName;

            if (stopName) {
              removeStopAndRefresh(
                stopName
              );
            }
          }
        );

      }
    );
}


// =====================================================
// SAVE / EDIT
// =====================================================

function ensureEditButton() {
  const saveButton =
    document.getElementById(
      "save-itinerary-btn"
    );

  let editButton =
    document.getElementById(
      "edit-itinerary-btn"
    );


  if (
    saveButton &&
    !editButton
  ) {

    editButton =
      document.createElement(
        "button"
      );

    editButton.type =
      "button";

    editButton.className =
      "btn btn-secondary btn-sm";

    editButton.id =
      "edit-itinerary-btn";

    editButton.textContent =
      "Edit";


    saveButton.insertAdjacentElement(
      "afterend",
      editButton
    );
  }


  return editButton;
}


function openSaveTitleModal(
  defaultTitle
) {
  const modal =
    document.getElementById(
      "save-title-modal"
    );

  const input =
    document.getElementById(
      "save-itinerary-title-input"
    );

  const errorElement =
    document.getElementById(
      "save-title-error"
    );


  if (
    !modal ||
    !input
  ) {
    return Promise.resolve(
      window.prompt(
        "Enter itinerary title:",
        defaultTitle
      )
    );
  }


  if (errorElement) {
    errorElement.style.display =
      "none";
  }


  input.maxLength =
    MAX_ITINERARY_TITLE_LENGTH;


  input.value =
    truncateText(
      defaultTitle || "",
      MAX_ITINERARY_TITLE_LENGTH
    );


  modal.style.display =
    "flex";


  modal.setAttribute(
    "aria-hidden",
    "false"
  );


  setTimeout(
    function () {
      input.focus();
      input.select();
    },
    50
  );


  return new Promise(
    function (resolve) {
      saveTitleResolver =
        resolve;
    }
  );
}


function closeSaveTitleModal(
  value
) {
  const modal =
    document.getElementById(
      "save-title-modal"
    );

  const errorElement =
    document.getElementById(
      "save-title-error"
    );


  if (modal) {
    modal.style.display =
      "none";

    modal.setAttribute(
      "aria-hidden",
      "true"
    );
  }


  if (errorElement) {
    errorElement.style.display =
      "none";
  }


  if (saveTitleResolver) {
    saveTitleResolver(
      value
    );

    saveTitleResolver =
      null;
  }
}


function confirmSaveTitle() {
  const input =
    document.getElementById(
      "save-itinerary-title-input"
    );

  const errorElement =
    document.getElementById(
      "save-title-error"
    );

  const title =
    input
      ? input.value.trim()
      : "";


  if (!title) {

    if (errorElement) {
      errorElement.textContent =
        "Please enter an itinerary title.";

      errorElement.style.display =
        "block";
    }

    input?.focus();

    return;
  }


  if (
    title.length >
    MAX_ITINERARY_TITLE_LENGTH
  ) {

    if (errorElement) {
      errorElement.textContent =
        `Title cannot exceed ${MAX_ITINERARY_TITLE_LENGTH} characters.`;

      errorElement.style.display =
        "block";
    }

    input?.focus();

    return;
  }


  closeSaveTitleModal(
    title
  );
}


function openSaveSuccessModal() {
  const modal =
    document.getElementById(
      "save-success-modal"
    );

  const okButton =
    document.getElementById(
      "save-success-ok"
    );


  if (!modal) {
    window.location.href =
      "/saved-itineraries";

    return;
  }


  modal.classList.add(
    "show"
  );


  modal.setAttribute(
    "aria-hidden",
    "false"
  );


  okButton?.focus();
}


function closeSaveSuccessModal() {
  const modal =
    document.getElementById(
      "save-success-modal"
    );

  if (modal) {
    modal.classList.remove(
      "show"
    );

    modal.setAttribute(
      "aria-hidden",
      "true"
    );
  }

  window.location.href =
    "/saved-itineraries";
}


function findTimetableItem(
  timetable,
  stopName
) {
  if (
    !Array.isArray(
      timetable
    )
  ) {
    return {};
  }

  return (
    timetable.find(
      item =>
        item.name ===
          stopName ||
        item.activity ===
          stopName
    ) ||
    {}
  );
}


function setSaveButtonsBusy(
  isBusy,
  label =
    "Saving..."
) {
  const saveButton =
    document.getElementById(
      "save-itinerary-btn"
    );

  const editButton =
    ensureEditButton();


  if (saveButton) {
    saveButton.disabled =
      isBusy;

    saveButton.textContent =
      isBusy
        ? label
        : (
            savedItineraryDocumentId
              ? "Saved"
              : "Save"
          );
  }


  if (editButton) {
    editButton.disabled =
      isBusy;

    editButton.textContent =
      isBusy
        ? label
        : "Edit";
  }
}


function redirectToSavedItineraryEdit(
  itineraryId
) {
  if (!itineraryId) {
    return;
  }

  window.location.href =
    `/saved-itineraries/${encodeURIComponent(itineraryId)}/edit`;
}


async function saveItinerary(
  options = {}
) {

  const redirectToEdit =
    Boolean(
      options.redirectToEdit
    );

  const skipTitlePrompt =
    Boolean(
      options.skipTitlePrompt
    );


  if (!currentUser) {
    openPlannerAlertModal(
      "Unable to Save",
      "Current user information is not available."
    );

    return null;
  }


  if (
    savedItineraryDocumentId
  ) {

    clearSmartItineraryState();


    if (
      redirectToEdit
    ) {
      redirectToSavedItineraryEdit(
        savedItineraryDocumentId
      );
    } else {
      openSaveSuccessModal();
    }


    return (
      savedItineraryDocumentId
    );
  }


  if (saveInProgress) {
    return null;
  }


  const plan =
    getJsonData(
      "plan-data"
    );

  const mapData =
    getJsonData(
      "map-data"
    );


  if (
    !plan ||
    !mapData
  ) {
    openPlannerAlertModal(
      "No Itinerary Found",
      "Please generate an itinerary before saving."
    );

    return null;
  }


  try {

    saveInProgress =
      true;


    setSaveButtonsBusy(
      true
    );


    const itineraryRef =
      doc(
        collection(
          db,
          ITINERARY_COLLECTION
        )
      );


    const itineraryId =
      itineraryRef.id;


    const startPoint =
      mapData.start ||
      {};


    const endPoint =
      mapData.end ||
      {};


    const startText =
      mapData.startText ||
      getFormValue(
        "start"
      ) ||
      "Start Location";


    const endText =
      mapData.endText ||
      getFormValue(
        "end"
      ) ||
      "End Location";


    const destinationDisplayName =
      mapData.endDisplayText ||
      shortLocationName(
        endText
      ) ||
      "Malaysia";


    const defaultItineraryTitle =
      `${destinationDisplayName} Trip`;


    const itineraryTitle =
      skipTitlePrompt
        ? defaultItineraryTitle
        : await openSaveTitleModal(
            defaultItineraryTitle
          );


    if (
      !itineraryTitle ||
      !itineraryTitle.trim()
    ) {

      saveInProgress =
        false;


      setSaveButtonsBusy(
        false
      );


      return null;
    }


    const cleanItineraryTitle =
      itineraryTitle.trim();


    const availableHours =
      Number(
        getFormValue(
          "available_hours",
          6
        )
      );


    const minimumRating =
      Number(
        getFormValue(
          "minimum_rating",
          4
        )
      );


    const travelDate =
      getFormValue(
        "trip_date"
      );


    const startTime =
      getFormValue(
        "start_time"
      );


    const selectedInterests =
      getSelectedInterests();


    const travelDurationMinutes =
      extractNumberFromText(
        plan.travel_duration ||
        plan.total_duration ||
        ""
      );


    const totalDurationMinutes =
      extractNumberFromText(
        plan.total_duration ||
        plan.itinerary_duration ||
        ""
      ) ||
      availableHours * 60;


    const selectedStops =
      plan.selected ||
      mapData.attractions ||
      [];


    await setDoc(
  itineraryRef,
  {

    itinerary_id:
      itineraryId,

    user_id:
      currentUser.uid,

    title:
      cleanItineraryTitle,

    destination:
      endText,

    start_location_name:
      startText,

    start_latitude:
      normaliseCoordinate(
        startPoint.latitude
      ),

    start_longitude:
      normaliseCoordinate(
        startPoint.longitude
      ),

    end_location_name:
      endText,

    end_latitude:
      normaliseCoordinate(
        endPoint.latitude
      ),

    end_longitude:
      normaliseCoordinate(
        endPoint.longitude
      ),

    travel_date:
      travelDate,

    start_time:
      startTime,

    trip_days:
      1,

    day_start_times: {
      "1":
        startTime
    },

    day_end_locations: {
      "1": {
        name:
          endText,

        latitude:
          normaliseCoordinate(
            endPoint.latitude
          ),

        longitude:
          normaliseCoordinate(
            endPoint.longitude
          )
      }
    },

    available_hours:
      availableHours,

    minimum_rating:
      minimumRating,

    interest:
      selectedInterests[0] ||
      "culture",

    interests:
      selectedInterests,

    total_distance_km:
      Number(
        plan.total_distance_km ||
        0
      ),

    google_maps_full_route_url:
      plan.google_maps_full_route_url ||
      "",

    travel_duration_minutes:
      travelDurationMinutes,

    total_duration_minutes:
      totalDurationMinutes,

    stop_count:
      selectedStops.length,

    status:
      "Draft",

    is_public:
      false,

    views:
      0,

    likes:
      0,

    saves:
      0,

    created_at:
      serverTimestamp(),

    updated_at:
      serverTimestamp(),

    published_at:
      null
  }
);



    for (
      let index = 0;
      index < selectedStops.length;
      index += 1
    ) {

      const stop =
        selectedStops[index];


      const stopAboutText =
        getAttractionAboutDescription(
          stop
        );


      const stopInterestTags =
        getDetailList(
          stop.matched_interests ||
          stop.interest_tags ||
          stop.interests ||
          stop.tags ||
          []
        )
          .filter(
            value =>
              ![
                "favourite",
                "attraction",
                "tourist attraction"
              ].includes(
                value.toLowerCase()
              )
          );


      const stopReasonTags =
        getUserFacingRecommendationReasons(
          stop
        );


      const timetableItem =
        findTimetableItem(
          plan.timetable ||
          [],
          stop.name
        );


      const stopRef =
        doc(
          collection(
            db,
            ITINERARY_STOP_COLLECTION
          )
        );


      const stopId =
        stopRef.id;


      await setDoc(
        stopRef,
        {

          stop_id:
            stopId,

          itinerary_id:
            itineraryId,

          place_id:
            stop.id ||
            stop.place_id ||
            "",

          stop_order:
            index + 1,

          day_number:
            1,

          stop_name:
            stop.name ||
            "Unnamed Stop",

          category:
            attractionCategory(
              stop
            ),

          rating:
            Number(
              stop.rating ||
              0
            ),

          latitude:
            normaliseCoordinate(
              stop.latitude
            ),

          longitude:
            normaliseCoordinate(
              stop.longitude
            ),

          arrival_time:
            timetableItem.arrival_time ||
            timetableItem.time ||
            "",

          departure_time:
            timetableItem.departure_time ||
            "",

          visit_duration_minutes:
            Number(
              stop.estimated_minutes ||
              0
            ),

          about_text:
            stopAboutText,

          interest_tags:
            stopInterestTags,

          reason_tags:
            stopReasonTags,

          travel_minutes_from_previous:
            extractNumberFromText(
              timetableItem.transport ||
              ""
            ),

          google_maps_url:
            timetableItem.google_maps_url ||
            "",

          google_maps_label:
            timetableItem.google_maps_label ||
            "",

          route_leg_from:
            timetableItem.route_leg_from ||
            "",

          route_leg_to:
            timetableItem.route_leg_to ||
            "",

          created_at:
            serverTimestamp(),

          updated_at:
            serverTimestamp()
        }
      );
    }


    savedItineraryDocumentId =
      itineraryId;


    saveInProgress =
      false;


    setSaveButtonsBusy(
      false
    );


    clearSmartItineraryState();


    if (
      redirectToEdit
    ) {

      redirectToSavedItineraryEdit(
        itineraryId
      );

    } else {

      openSaveSuccessModal();
    }


    return itineraryId;


  } catch (error) {

    console.error(
      "Failed to save itinerary:",
      error
    );


    openPlannerAlertModal(
      "Save Failed",
      "Failed to save itinerary. Please try again."
    );


    saveInProgress =
      false;


    setSaveButtonsBusy(
      false
    );


    return null;
  }
}


async function editSavedItinerary() {

  if (
    savedItineraryDocumentId
  ) {

    clearSmartItineraryState();


    redirectToSavedItineraryEdit(
      savedItineraryDocumentId
    );


    return;
  }


  await saveItinerary({
    redirectToEdit:
      true,

    skipTitlePrompt:
      true
  });
}


function bindResultSaveEditActionsIfNeeded() {
  const saveButton =
    document.getElementById(
      "save-itinerary-btn"
    );


  const editButton =
    ensureEditButton();


  if (
    saveButton &&
    saveButton.dataset.saveBound !==
      "1"
  ) {

    saveButton.dataset.saveBound =
      "1";


    saveButton.addEventListener(
      "click",
      function () {

        saveItinerary();

      }
    );
  }


  if (
    editButton &&
    editButton.dataset.editBound !==
      "1"
  ) {

    editButton.dataset.editBound =
      "1";


    editButton.addEventListener(
      "click",
      editSavedItinerary
    );
  }
}


function rehydrateRestoredPlanner() {
  clearRuntimeBindingFlags(
    document.querySelector(
      ".itinerary-result-col"
    )
  );

  bindPlaceDetailButtons();

  bindRemoveStopButtons();

  bindResultSaveEditActionsIfNeeded();

  loadLeafletForRestoredRoute();
}


// =====================================================
// INIT
// =====================================================

document.addEventListener(
  "DOMContentLoaded",
  async function () {

    if (
      replaceGeneratedPostWithGet()
    ) {
      return;
    }

    /*
      Authentication/page protection
      is handled by auth-guard.js.

      Planner only reads the
      already authenticated user.
    */
    await auth.authStateReady();

    currentUser =
      auth.currentUser;


    /*
      Favourite data
    */
    if (currentUser) {

      if (
        restoreFavouritePlacesFromLocalStorage(
          currentUser
        )
      ) {

        const loadingElement =
          document.getElementById(
            "favourites-loading"
          );


        if (loadingElement) {
          loadingElement.style.display =
            "none";
        }


        renderFavouritePlaces();
      }


      loadFavouritePlaces(
        currentUser
      )
        .catch(
          function (error) {

            console.error(
              "Failed to load favourite places:",
              error
            );


            renderFavouriteError();
          }
        );
    }


    updateDateTimeLimits();


    const restoredResult =
      restoreSmartItineraryState();


    const plannerAlertOkButton =
      document.getElementById(
        "planner-alert-ok"
      );


    const plannerAlertModal =
      document.getElementById(
        "planner-alert-modal"
      );


    plannerAlertOkButton
      ?.addEventListener(
        "click",
        closePlannerAlertModal
      );


    plannerAlertModal
      ?.addEventListener(
        "click",
        function (event) {

          if (
            event.target ===
            plannerAlertModal
          ) {
            closePlannerAlertModal();
          }

        }
      );


    /*
      Interest chips
    */
    document
      .querySelectorAll(
        ".interest-chip input"
      )
      .forEach(
        function (checkbox) {

          checkbox.addEventListener(
            "change",
            function () {

              checkbox
                .closest(
                  ".interest-chip"
                )
                ?.classList
                .toggle(
                  "active",
                  checkbox.checked
                );


              persistSmartItineraryState();
            }
          );

        }
      );


    const tripDateInput =
      document.getElementById(
        "trip_date"
      );


    const startTimeInput =
      document.getElementById(
        "start_time"
      );


    const itineraryForm =
      document.getElementById(
        "itinerary-form"
      );


    tripDateInput
      ?.addEventListener(
        "change",
        updateDateTimeLimits
      );


    startTimeInput
      ?.addEventListener(
        "change",
        validateTripDateTime
      );


    itineraryForm
      ?.addEventListener(
        "submit",
        function (event) {

          if (
            !validateTripDateTime() ||
            !validateFavouriteSelection() ||
            !validateInterestSelection()
          ) {

            event.preventDefault();

            hidePlannerLoading();

            return;
          }


          persistSmartItineraryState();


          showPlannerLoading(
            "Generating itinerary..."
          );

        }
      );


    /*
      Persist form state
    */
    document
      .querySelectorAll(
        "#itinerary-form input, #itinerary-form select"
      )
      .forEach(
        function (element) {

          element.addEventListener(
            "change",
            persistSmartItineraryState
          );


          element.addEventListener(
            "input",
            persistSmartItineraryState
          );

        }
      );


    window.addEventListener(
      "pagehide",
      persistSmartItineraryState
    );


    /*
      Available hours / max stops
    */
    updateMaximumStopsOptions();


    const availableHoursSelect =
      document.getElementById(
        "available_hours"
      );


    const maxStopsSelect =
      document.getElementById(
        "max_stops"
      );


    availableHoursSelect
      ?.addEventListener(
        "change",
        function () {

          updateMaximumStopsOptions();

          enforceFavouriteLimit();

          persistSmartItineraryState();
        }
      );


    maxStopsSelect
      ?.addEventListener(
        "change",
        function () {

          enforceFavouriteLimit();

          persistSmartItineraryState();
        }
      );


    /*
      GPS
    */
    document
      .getElementById(
        "use-current-location-btn"
      )
      ?.addEventListener(
        "click",
        useCurrentLocation
      );


    document
      .getElementById(
        "clear-current-location-btn"
      )
      ?.addEventListener(
        "click",
        clearCurrentLocation
      );


    resetGpsWhenStartEdited();

    updateCurrentLocationUi();


    /*
      Autocomplete
    */
    setupLocationAutocomplete(
      "start",
      "start-suggestions"
    );


    setupLocationAutocomplete(
      "end",
      "end-suggestions"
    );


    document.addEventListener(
      "click",
      function (event) {

        if (
          event.target.closest(
            ".location-autocomplete"
          )
        ) {
          return;
        }


        hideLocationSuggestions(
          document.getElementById(
            "start-suggestions"
          )
        );


        hideLocationSuggestions(
          document.getElementById(
            "end-suggestions"
          )
        );

      }
    );


    /*
      Favourite search
    */
    const favouritesSearchInput =
      document.getElementById(
        "favourites-search"
      );


    favouritesSearchInput
      ?.addEventListener(
        "input",
        function () {

          favouriteSearchText =
            favouritesSearchInput.value ||
            "";


          renderFavouritePlaces();
        }
      );


    /*
      Timetable controls
    */
    if (
      !restoredResult
    ) {

      bindPlaceDetailButtons();

      bindRemoveStopButtons();
    }


    /*
      Route map
    */
    if (
      restoredResult
    ) {

      rehydrateRestoredPlanner();

    } else if (
      typeof L !==
      "undefined"
    ) {

      initRouteMap();
    }


    /*
      Save title modal
    */
    const cancelSaveTitleButton =
      document.getElementById(
        "cancel-save-title-btn"
      );


    const confirmSaveTitleButton =
      document.getElementById(
        "confirm-save-title-btn"
      );


    const saveTitleInput =
      document.getElementById(
        "save-itinerary-title-input"
      );


    const saveTitleModal =
      document.getElementById(
        "save-title-modal"
      );


    cancelSaveTitleButton
      ?.addEventListener(
        "click",
        function () {

          closeSaveTitleModal(
            null
          );

        }
      );


    confirmSaveTitleButton
      ?.addEventListener(
        "click",
        confirmSaveTitle
      );


    saveTitleInput
      ?.addEventListener(
        "keydown",
        function (event) {

          if (
            event.key ===
            "Enter"
          ) {

            event.preventDefault();

            confirmSaveTitle();
          }


          if (
            event.key ===
            "Escape"
          ) {

            closeSaveTitleModal(
              null
            );
          }

        }
      );


    saveTitleModal
      ?.addEventListener(
        "click",
        function (event) {

          if (
            event.target ===
            saveTitleModal
          ) {

            closeSaveTitleModal(
              null
            );
          }

        }
      );


    /*
      Save / Edit
    */
    bindResultSaveEditActionsIfNeeded();


    /*
      Place Detail modal
    */
    const detailModal =
      document.getElementById(
        "itinerary-attraction-modal"
      );


    const detailCloseButton =
      document.getElementById(
        "itinerary-detail-close"
      );


    detailCloseButton
      ?.addEventListener(
        "click",
        closeItineraryAttractionDetail
      );


    detailModal
      ?.addEventListener(
        "click",
        function (event) {

          if (
            event.target ===
            detailModal
          ) {

            closeItineraryAttractionDetail();
          }

        }
      );


    /*
      Save success modal
    */
    const saveSuccessOkButton =
      document.getElementById(
        "save-success-ok"
      );


    const saveSuccessModal =
      document.getElementById(
        "save-success-modal"
      );


    saveSuccessOkButton
      ?.addEventListener(
        "click",
        closeSaveSuccessModal
      );


    saveSuccessModal
      ?.addEventListener(
        "click",
        function (event) {

          if (
            event.target ===
            saveSuccessModal
          ) {

            closeSaveSuccessModal();
          }

        }
      );


    /*
      ESC key
    */
    document.addEventListener(
      "keydown",
      function (event) {

        if (
          event.key !==
          "Escape"
        ) {
          return;
        }


        if (
          plannerAlertModal
            ?.classList
            .contains(
              "show"
            )
        ) {

          closePlannerAlertModal();

          return;
        }


        if (
          saveTitleModal
            ?.style
            .display ===
          "flex"
        ) {

          closeSaveTitleModal(
            null
          );

          return;
        }


        if (
          detailModal
            ?.classList
            .contains(
              "show"
            )
        ) {

          closeItineraryAttractionDetail();
        }

      }
    );

  }
);
