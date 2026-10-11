javascript:(function () {
  if (document.location.hostname !== "old.reddit.com" || !window.pd || !window.pd.api) {
    alert("Use this recovery bookmark on the existing old.reddit.com PowerDeleteSuite tab. Do not refresh the failed run.");
    return;
  }
  fetch("https://raw.githubusercontent.com/extricator/PowerDeleteSuite/master/recovery.js?t=" + Date.now())
    .then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.text();
    }).then(function (source) {
      if (!source.trim()) throw new Error("Empty recovery download");
      var script = document.createElement("script");
      script.textContent = source;
      document.body.appendChild(script);
    }).catch(function (error) { alert("Recovery download failed: " + error.message); });
})();
