// YouTube Feed Filter — Popup Script

const DEFAULTS = {
  hideLivestreams: true,
  hideLowViews: true,
  viewThreshold: 50000,
  hideShorts: true,
  hideMixes: true,
  hidePlayables: true,
  hideMembersOnly: true,
  autoplayIntercept: true,
  countdownSeconds: 10,
};

const TOGGLE_IDS = [
  "hideLivestreams",
  "hideLowViews",
  "hideShorts",
  "hideMixes",
  "hidePlayables",
  "hideMembersOnly",
  "autoplayIntercept",
];

const NUMBER_IDS = ["viewThreshold", "countdownSeconds"];

function loadSettings() {
  browser.storage.local.get(DEFAULTS).then((settings) => {
    for (const id of TOGGLE_IDS) {
      document.getElementById(id).checked = settings[id];
    }
    for (const id of NUMBER_IDS) {
      document.getElementById(id).value = settings[id];
    }
  });
}

function saveAndNotify(key, value) {
  const update = { [key]: value };
  browser.storage.local.set(update).then(() => {
    // Send to all YouTube tabs
    browser.tabs.query({ url: "*://*.youtube.com/*" }).then((tabs) => {
      for (const tab of tabs) {
        browser.tabs.sendMessage(tab.id, {
          type: "ytf-settings-update",
          settings: update,
        }).catch(() => {});
      }
    });
  });
}

function init() {
  loadSettings();

  for (const id of TOGGLE_IDS) {
    document.getElementById(id).addEventListener("change", (e) => {
      saveAndNotify(id, e.target.checked);
    });
  }

  for (const id of NUMBER_IDS) {
    const el = document.getElementById(id);
    el.addEventListener("change", () => {
      let val = parseInt(el.value, 10);
      if (isNaN(val)) val = DEFAULTS[id];
      if (el.min && val < parseInt(el.min, 10)) val = parseInt(el.min, 10);
      if (el.max && val > parseInt(el.max, 10)) val = parseInt(el.max, 10);
      el.value = val;
      saveAndNotify(id, val);
    });
  }
}

document.addEventListener("DOMContentLoaded", init);
