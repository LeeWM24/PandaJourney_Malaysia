// Saved Itineraries Page

document.addEventListener("DOMContentLoaded", function () {
  const deleteForms = document.querySelectorAll(".js-delete-itinerary-form");

  deleteForms.forEach(function (form) {
    form.addEventListener("submit", function (event) {
      const confirmed = confirm("Delete this itinerary?");

      if (!confirmed) {
        event.preventDefault();
      }
    });
  });
});