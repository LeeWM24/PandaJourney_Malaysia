// ================================
// Smart Attraction Recommendation
// (Kaixi)
// ================================

function readJsonData(elementId, fallback) {
  const el = document.getElementById(elementId);
  if (!el) return fallback;
  try {
    return JSON.parse(el.textContent);
  } catch {
    return fallback;
  }
}

const attractionsData = readJsonData('attraction-data', []);

// Favourite state is loaded from the server (attraction.is_favourite, set
// by app.py from the persisted favourites store), not from localStorage,
// so favourites are shared across devices/browsers instead of being
// stuck on whichever browser starred them.
const favourites = new Set(
  attractionsData.filter((item) => item.is_favourite).map((item) => item.id)
);
let hasSearched = false;
let appliedFilters = { dest: '', interests: [], minRating: '0', weather: false };
let currentAttr = null;
let toastTimer = null;

document.addEventListener('DOMContentLoaded', () => {
  initializeChipState();
  bindFilterEvents();
  bindPanelEvents();
  renderCards();
  updateFavUI();
});

function initializeChipState() {
  document.querySelectorAll('.chip[data-chip]').forEach((chip) => {
    const checkbox = chip.querySelector('input[type="checkbox"]');
    if (!checkbox) return;
    chip.classList.toggle('active', checkbox.checked);
    // update class when checkbox value changes
    checkbox.addEventListener('change', () => {
      chip.classList.toggle('active', checkbox.checked);
    });
    // also allow clicking the chip container to toggle
    chip.addEventListener('click', (ev) => {
      // ignore if click was on a real focusable element
      if (ev.target.tagName.toLowerCase() === 'input') return;
      checkbox.checked = !checkbox.checked;
      checkbox.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
}

// Leaflet (OpenStreetMap) integration
// Leaflet is loaded eagerly via a plain <script> tag in smart_attraction.html
// (same pattern as the itinerary planner's routeMap), so `L` is already
// available globally by the time this file runs — no dynamic script
// injection needed.
let _map = null;
let _marker = null;

function createMap() {
  try {
    if (!_map && typeof L !== 'undefined') {
      const el = document.getElementById('detail-map');
      _map = L.map(el, { center: [3.139, 101.6869], zoom: 12, scrollWheelZoom: false });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '&copy; OpenStreetMap contributors'
      }).addTo(_map);
    }
    return _map;
  } catch (e) {
    console.warn('createMap error:', e);
    return null;
  }
}

function updateMapForAttraction(attraction) {
  if (!attraction) return;
  const lat = Number(attraction.latitude || attraction.lat || attraction.latitude_deg || 0);
  const lng = Number(attraction.longitude || attraction.lon || attraction.lng || 0);

  const linkEl = document.getElementById('detail-map-link');

  if (!lat || !lng) {
    if (linkEl) linkEl.style.display = 'none';
    return;
  }

  // Delay to ensure the detail panel is fully visible before initializing
  // the map, since Leaflet needs a laid-out container to size itself.
  setTimeout(() => {
    const map = createMap();
    if (!map) return;

    try {
      // Ensure the map knows its container size (fixes cropped/partial tiles)
      map.invalidateSize();
    } catch (e) { console.warn('invalidateSize error:', e); }

    const pos = [lat, lng];
    map.setView(pos, 15);

    // Remove old marker if it exists
    if (_marker) {
      try {
        map.removeLayer(_marker);
        _marker = null;
      } catch (e) { console.warn('removeLayer error:', e); }
    }

    // Create and add new marker
    try {
      _marker = L.marker(pos)
        .addTo(map)
        .bindPopup(attraction.name || 'Attraction')
        .openPopup();
    } catch (e) { console.warn('marker creation error:', e); }

    // Point the "Open in OpenStreetMap" link at this attraction's coordinates
    if (linkEl) {
      linkEl.href = getMapsUrl({ latitude: lat, longitude: lng });
      linkEl.style.display = 'inline-flex';
    }
  }, 150);
}

function bindFilterEvents() {
  document.getElementById('filter-form').addEventListener('submit', (event) => {
    event.preventDefault();
    handleSearch();
  });

  document.getElementById('sort-select').addEventListener('change', renderCards);
  document.getElementById('filter-rating').addEventListener('change', () => { if (hasSearched) renderCards(); });
  document.getElementById('destination').addEventListener('input', () => { if (hasSearched) renderCards(); });
  document.getElementById('weather_aware').addEventListener('change', () => { if (hasSearched) renderCards(); });
  const clearFiltersButton = document.getElementById('clear-filters');
  if (clearFiltersButton) clearFiltersButton.addEventListener('click', clearFilters);
}

function bindPanelEvents() {
  document.getElementById('detail-close').addEventListener('click', closeDetail);
  document.getElementById('detail-close-btn').addEventListener('click', closeDetail);
  document.getElementById('detail-backdrop').addEventListener('click', (event) => {
    if (event.target === event.currentTarget) closeDetail();
  });
  document.getElementById('detail-fav-btn').addEventListener('click', () => {
    const id = Number(document.getElementById('detail-fav-btn').dataset.favId);
    if (!Number.isNaN(id)) toggleFavourite(id);
  });
}

// Return an OpenStreetMap URL
function getMapsUrl(attraction, zoom = 17) {
  if (!attraction) return '';
  const lat = Number(attraction.latitude || attraction.lat || attraction.latitude_deg || 0);
  const lng = Number(attraction.longitude || attraction.lon || attraction.lng || 0);
  if (lat && lng) {
    return `https://www.openstreetmap.org/?mlat=${encodeURIComponent(lat)}&mlon=${encodeURIComponent(lng)}#map=${zoom}/${encodeURIComponent(lat)}/${encodeURIComponent(lng)}`;
  }
  const query = `${attraction.name || ''} ${attraction.area || attraction.location || ''}`.trim();
  return `https://www.openstreetmap.org/search?query=${encodeURIComponent(query)}`;
}

function handleSearch() {
  appliedFilters = {
    dest: document.getElementById('destination').value.trim(),
    interests: getSelectedInterests(),
    minRating: document.getElementById('filter-rating').value || '0',
    weather: document.getElementById('weather_aware').checked,
  };
  hasSearched = true;
  const clearBtn = document.getElementById('clear-filters');
  if (clearBtn) {
    clearBtn.removeAttribute('hidden');
    clearBtn.style.display = '';
  }
  renderCards();
}

function clearFilters() {
  document.getElementById('filter-form').reset();
  appliedFilters = { dest: '', interests: [], minRating: '0', weather: false };
  hasSearched = false;
  const clearBtn = document.getElementById('clear-filters');
  if (clearBtn) {
    clearBtn.setAttribute('hidden', '');
    clearBtn.style.display = 'none';
  }
  document.querySelectorAll('.chip[data-chip]').forEach((chip) => {
    const checkbox = chip.querySelector('input[type="checkbox"]');
    if (checkbox) {
      checkbox.checked = false;
      chip.classList.remove('active');
    }
  });
  renderCards();
}

function getSelectedInterests() {
  return [...document.querySelectorAll('input[name="interests"]:checked')].map((input) => input.value);
}

const RATING_MIN = { '0': 0, '3.0': 3, '4.0': 4, '4.5': 4.5 };

function getFilteredAttractions() {
  // Show all attractions by default until the user applies filters/search
  if (!hasSearched) return Array.isArray(attractionsData) ? [...attractionsData] : [];
  return attractionsData.filter((item) => {
    if (appliedFilters.dest) {
      // Match the destination box against the attraction's name, tags and
      // location/area — the demo data's "location" field is almost always
      // just the data source label, so matching on location alone meant a
      // typed destination (e.g. "museum", "Bukit Bintang") would rarely
      // find anything.
      const query = appliedFilters.dest.toLowerCase();
      const name = String(item.name || '').toLowerCase();
      const location = String(item.location || item.area || '').toLowerCase();
      const tagsRaw = item.interest_tags || item.tags || [];
      const tags = (Array.isArray(tagsRaw) ? tagsRaw : [tagsRaw]).map((tag) => String(tag).toLowerCase());
      const matches = name.includes(query) || location.includes(query) || tags.some((tag) => tag.includes(query));
      if (!matches) return false;
    }
    if (appliedFilters.interests.length > 0) {
      // match when the attraction has any of the selected interests (OR logic)
      const itemInterestsRaw = item.interests || item.interest_tags || item.tags || [];
      const itemInterests = (Array.isArray(itemInterestsRaw) ? itemInterestsRaw : [itemInterestsRaw]).map(x => String(x).toLowerCase());
      const selected = appliedFilters.interests.map(x => String(x).toLowerCase());
      const matchesInterest = selected.some((interest) => itemInterests.includes(interest));
      if (!matchesInterest) return false;
    }
    const minimum = RATING_MIN[appliedFilters.minRating] || 0;
    if (minimum && Number(item.rating) < minimum) return false;
    return true;
  });
}

function getSortedAttractions(list) {
  const mode = document.getElementById('sort-select').value;
  return [...list].sort((a, b) => {
    if (mode === 'rating') return Number(b.rating || 0) - Number(a.rating || 0);
    if (mode === 'nearest') return Number(a.distance_km ?? Infinity) - Number(b.distance_km ?? Infinity);
    return 0;
  });
}

function renderCards() {
  const filtered = getFilteredAttractions();
  const sorted = getSortedAttractions(filtered);
  const grid = document.getElementById('cards-grid');
  const countEl = document.getElementById('results-count');
  const noteEl = document.getElementById('results-note');
  const weatherEl = document.getElementById('weather-note');

  const label = hasSearched ? `result${sorted.length !== 1 ? 's' : ''}` : 'attractions';
  countEl.innerHTML = `Showing <strong>${sorted.length}</strong> ${label}`;
  if (!hasSearched) {
    noteEl.textContent = 'Showing all attractions — apply filters to refine results.';
  } else if (sorted.length === 0) {
    noteEl.textContent = 'No attractions matched your selections. Try relaxing one filter.';
  } else {
    noteEl.textContent = `Found ${sorted.length} attraction${sorted.length !== 1 ? 's' : ''} that match your filters.`;
  }

  if (appliedFilters.weather) {
    weatherEl.style.display = 'block';
    weatherEl.textContent = 'Weather-aware filtering is enabled.';
  } else {
    weatherEl.style.display = 'none';
    weatherEl.textContent = '';
  }

  if (sorted.length === 0) {
    if (!hasSearched) {
      grid.innerHTML = '';
      return;
    }
    grid.innerHTML = `
      <div class="card card-p" style="grid-column: 1 / -1;">
        <div class="empty-state">
          <div class="empty-icon">🌴</div>
          <div class="empty-title">No attractions found</div>
          <div class="empty-desc">Try a different destination, interest, or rating range.</div>
        </div>
      </div>`;
    return;
  }

  grid.innerHTML = sorted.map((attraction) => buildCard(attraction)).join('');
  updateCardFavourites();
}

function buildCard(attraction) {
  const isFav = favourites.has(attraction.id);
  const weatherBadge = {
    'Sunny': '<span class="badge badge-warning">☀️ Sunny</span>',
    'Partly Cloudy': '<span class="badge badge-muted">⛅ Partly Cloudy</span>',
    'Indoor': '<span class="badge badge-info">🏛️ Indoor</span>',
  }[attraction.weather_suitability] || '';

  const reasons = (attraction.reason_tags || []).map((reason) => `<span class="reason-tag">${reason}</span>`).join('');
  const locationLabel = attraction.location || attraction.area || 'Unknown location';
  const ratingText = attraction.rating ? Number(attraction.rating).toFixed(1) : 'N/A';

  return `
    <article class="attr-card">
      <button class="attr-card-img-wrap" type="button" onclick="openDetail(${attraction.id})" aria-label="View details for ${attraction.name}">
        <img src="${attraction.image_url || ''}" alt="${attraction.name}" loading="lazy" />
        <div class="attr-card-img-overlay"><span class="img-hint">View details</span></div>
        <div class="img-badge-tr">${weatherBadge}</div>
        <div class="img-fav-badge ${isFav ? 'show' : ''}">★</div>
      </button>
      <div class="attr-card-body">
        <div class="attr-card-title-row">
          <div class="attr-card-name">${attraction.name}</div>
          <div class="attr-card-rating">⭐ ${ratingText}</div>
        </div>
        <div class="attr-card-meta">
          <span class="reason-tag" style="background:#eff6ff;color:#1d4ed8;border-color:#bfdbfe;">${attraction.category || ''}</span>
          <span class="attr-card-loc">📍 ${locationLabel}</span>
        </div>
        <div class="attr-card-reasons">${reasons}</div>
        <div class="attr-card-actions">
          <button class="btn-view-details" type="button" onclick="openDetail(${attraction.id})">View details</button>
          <button class="btn-fav ${isFav ? 'active' : ''}" id="btn-fav-${attraction.id}" type="button" onclick="toggleFavourite(${attraction.id})" title="${isFav ? 'Remove from favourites' : 'Save to favourites'}">${isFav ? '★' : '☆'}</button>
        </div>
      </div>
    </article>`;
}

function updateCardFavourites() {
  document.querySelectorAll('.btn-fav').forEach((button) => {
    const id = Number(button.id.replace('btn-fav-', ''));
    const isFav = favourites.has(id);
    button.classList.toggle('active', isFav);
    button.textContent = isFav ? '★' : '☆';
    button.title = isFav ? 'Remove from favourites' : 'Save to favourites';
  });
}

async function toggleFavourite(id) {
  const attraction = attractionsData.find((item) => item.id === id);
  if (!attraction) return;

  try {
    const response = await fetch('/api/favourites/toggle', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: attraction.name,
        category: attraction.category || '',
        rating: attraction.rating || 0,
        image_url: attraction.image_url || '',
        area: attraction.area || attraction.location || '',
        waze_url: attraction.waze_url || '',
      }),
    });

    if (!response.ok) throw new Error('Request failed');

    const result = await response.json();

    if (result.is_favourite) {
      favourites.add(id);
      attraction.is_favourite = true;
      showToast('★ Saved to favourites!');
    } else {
      favourites.delete(id);
      attraction.is_favourite = false;
      showToast('Removed from favourites');
    }

    renderCards();
    updateFavUI();
    syncDetailFavourite(id, favourites.has(id));
  } catch (error) {
    showToast('Could not update favourites — please try again.');
  }
}

function updateFavUI() {
  const count = favourites.size;
  const favChip = document.getElementById('fav-count-chip');
  const favCount = document.getElementById('fav-count');
  const panelChip = document.getElementById('fav-chip');
  if (favChip) favChip.style.display = count > 0 ? 'inline-flex' : 'none';
  if (favCount) favCount.textContent = `${count}`;
  if (panelChip) panelChip.classList.toggle('show', count > 0);
}

function syncDetailFavourite(id, active) {
  const favBtn = document.getElementById('detail-fav-btn');
  if (!favBtn) return;
  favBtn.textContent = active ? '★ Saved to favourite' : 'Save as favourite';
  favBtn.classList.toggle('saved', active);
  favBtn.dataset.favId = id;
}

function openDetail(id) {
  const attraction = attractionsData.find((item) => item.id === id);
  if (!attraction) return;
  currentAttr = attraction;
  const gallery = attraction.photo_urls && attraction.photo_urls.length ? attraction.photo_urls : [attraction.image_url || ''];
  const mainImage = document.getElementById('detail-main-image');
  const nameEl = document.getElementById('detail-name');
  const metaTop = document.getElementById('detail-meta-top');
  const metaBottom = document.getElementById('detail-meta-bottom');
  const hoursEl = document.getElementById('detail-hours');
  const feeEl = document.getElementById('detail-fee');
  const durationEl = document.getElementById('detail-duration');
  const descEl = document.getElementById('detail-description');
  const reasonsEl = document.getElementById('detail-reasons');
  const interestsEl = document.getElementById('detail-interests');
  const tipsEl = document.getElementById('detail-tips');
  const areaEl = document.getElementById('detail-area');
  const sourceEl = document.getElementById('detail-source');
  const galleryEl = document.getElementById('detail-gallery');

  mainImage.src = gallery[0] || '';
  nameEl.textContent = attraction.name || 'Attraction';
  metaTop.innerHTML = `
    <span>${attraction.weather_suitability || 'Unknown'}</span>
    <span>${attraction.category || ''}</span>`;
  metaBottom.innerHTML = `
    <span>${attraction.area || attraction.location || ''}</span>
    <span>⭐ ${attraction.rating ? Number(attraction.rating).toFixed(1) : 'N/A'}</span>`;
  hoursEl.textContent = attraction.hours || 'N/A';
  feeEl.textContent = attraction.entry_fee || 'N/A';
  durationEl.textContent = attraction.estimated_minutes ? `${attraction.estimated_minutes} mins` : 'N/A';
  descEl.textContent = attraction.description || 'No description available.';
  areaEl.textContent = attraction.area || attraction.location || 'Unknown location';
  sourceEl.textContent = attraction.source || 'Local demo dataset';

  reasonsEl.innerHTML = (attraction.reason_tags || []).map((reason) => `<span class="detail-pill">${reason}</span>`).join('');
  interestsEl.innerHTML = (attraction.interest_tags || attraction.interests || []).map((interest) => `<span class="detail-pill">${interest}</span>`).join('');
  tipsEl.innerHTML = (attraction.visitor_tips || []).map((tip) => `<li><span class="tip-dot">•</span>${tip}</li>`).join('');

  galleryEl.innerHTML = gallery.map((photo, index) => `
    <button id="thumb-${index}" type="button" class="detail-thumb ${index === 0 ? 'active' : ''}" onclick="setGalleryImg(${index})">
      <img src="${photo}" alt="Gallery ${index + 1}" />
    </button>`).join('');

  document.getElementById('detail-backdrop').classList.add('active');
  document.body.style.overflow = 'hidden';

  syncDetailFavourite(id, favourites.has(id));
  // initialize the interactive map for this attraction
  try {
    updateMapForAttraction(attraction);
  } catch (e) { /* ignore */ }
}

function setGalleryImg(index) {
  if (!currentAttr) return;
  const images = currentAttr.photo_urls && currentAttr.photo_urls.length ? currentAttr.photo_urls : [currentAttr.image_url || ''];
  document.getElementById('detail-main-image').src = images[index] || '';
  images.forEach((_, idx) => {
    document.getElementById(`thumb-${idx}`)?.classList.toggle('active', idx === index);
  });
}

function closeDetail() {
  document.getElementById('detail-backdrop').classList.remove('active');
  document.body.style.overflow = '';
}

function showToast(message) {
  const toastEl = document.getElementById('toast');
  if (!toastEl) return;
  toastEl.textContent = message;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
}