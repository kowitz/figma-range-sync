const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const moment = require("moment");
const PromiseThrottle = require("promise-throttle");
const yaml = require("js-yaml");

// Load configuration file
const CONF = yaml.safeLoad(fs.readFileSync("./conf.yaml", "utf8"));

// Trottled API for Figma requests
const figma = axios.create({
  baseURL: "https://api.figma.com/v1/",
  timeout: CONF.settings.figmaTimeout,
  headers: { "X-FIGMA-TOKEN": CONF.figma.accessToken },
  httpAgent: new http.Agent({ keepAlive: true })
});
const promiseThrottle = new PromiseThrottle({
  requestsPerSecond: CONF.settings.figmaRequestsPerSecond,
  promiseImplementation: Promise
});
figma.interceptors.request.use(config => {
  return promiseThrottle.add(() => {
    return Promise.resolve(config);
  });
});

// Simple Logging with timestamps
function log(str, data) {
  console.log(moment().format() + "\t" + str);
  if (data) {
    console.log(data);
  }
}

// Time marker to look for new changes after
var lastSyncedTime = moment().subtract(
  CONF.settings.initialImportHistoryMinutes,
  "minutes"
);

// Requests recently changes files from Figma, and syncs them to Range.
// Returns a Promise
function syncFigmaToRange() {
  log("🔁 Syncing Figma ---> Range");
  log(`Finding activity since ${lastSyncedTime.fromNow()}`);
  var syncStartTime = moment();
  getFigmaProjectsForTeam(CONF.figma.teamID)
    .then(getFigmaFilesForProjects)
    .then(filterFigmaFilesToEditedAfter(lastSyncedTime))
    .then(getFigmaVersionForFiles)
    .then(addEditorsSince(lastSyncedTime))
    .then(createRangePayloads)
    .then(sendRangePayloads)
    .then(() => {
      log("🎉 Sync successful!");
      lastSyncedTime = syncStartTime.subtract(1, "minutes");
    })
    .catch(err => {
      if (err.code === "ECONNRESET" || err.code === "ECONNABORTED") {
        log("ERROR: Network connection reset or aborted");
      } else if (err.message) {
        log("ERROR: " + err.message);
      } else {
        log("ERROR:", err);
      }
      log("😭 Sync unsucessful.");
    });
}

// Let's go!
log("🚀 Figma+Range Sync Service Started");
syncFigmaToRange();
setInterval(syncFigmaToRange, CONF.settings.pollingIntervalMinutes * 60 * 1000);

// Requests Figma Projects the belong to a TeamID
// Returns a Promise to return an array of Projects [{id, name},...]
function getFigmaProjectsForTeam(teamId) {
  return figma.get(`/teams/${teamId}/projects`).then(({ data }) => {
    log(`Fetched ${data.projects.length} projects`);
    return Promise.resolve(data.projects);
  });
}

// Fetches all Figma files for a given set of figma Projects
// figmaProjects: Array of Figma projects [{id, name},...]
// Returns promise to return an array of Files
function getFigmaFilesForProjects(figmaProjects) {
  var fileRequests = figmaProjects.map(project => {
    return figma.get(`/projects/${project.id}/files`);
  });
  return Promise.all(fileRequests).then(fileRequestResponses => {
    var files = [];
    fileRequestResponses.forEach(response => {
      response.data.files.forEach(file => {
        files.push(file);
      });
    });
    log(`Fetched ${files.length} files`);
    return Promise.resolve(files);
  });
}

// Returns a function that filters a list of Figma files
// to those edited after a specified time.
function filterFigmaFilesToEditedAfter(momentMarker) {
  return figmaFiles => {
    var recentFiles = figmaFiles.filter(file => {
      return moment(file.last_modified).isAfter(momentMarker);
    });
    if (recentFiles.length > 0) {
      log(`Files changed since marker: ${recentFiles.length}`);
    } else {
      log("No files changed since marker");
    }
    return Promise.resolve(recentFiles);
  };
}

// Fetches the versions for Figma Files
// Promise resolves to [{file: ..., versions...}, ...]
function getFigmaVersionForFiles(files) {
  versionRequests = [];
  files.forEach(file => {
    versionRequests.push(
      figma.get(`/files/${file.key}/versions`).then(resp => {
        return {
          file: file,
          versions: resp.data.versions
        };
      })
    );
  });
  return Promise.all(versionRequests).then(files => {
    log(`Fetched versions for ${files.length} files.`);
    return Promise.resolve(files);
  });
}

// For each Figma file, generates a set of editors
// who have modified the document since a specified time.
// Promise returns [{file:..., versions:..., editors: ...}, ...]
function addEditorsSince(momentMarker) {
  return entries => {
    entries.forEach(entry => {
      log(`• ${entry.file.name}`);
      var editorsMap = new Map();
      entry.versions.forEach((version, index) => {
        if ((index === 0) | moment(version.created_at).isAfter(momentMarker)) {
          editorsMap.set(version.user.id, version.user.handle);
        }
      });
      entry.editors = [];
      editorsMap.forEach((handle, id) => {
        var editorEmail = getEmailFromHandle(handle);
        if (editorEmail === undefined) {
          log(`  └ ${handle} : 😭 Not found in config file`);
        } else {
          entry.editors.push({
            name: handle,
            email: editorEmail
          });
          log(`  └ ${handle} : ${editorEmail}`);
        }
      });
    });
    return Promise.resolve(entries);
  };
}

function getEmailFromHandle(handle) {
  for (var name in CONF.users) {
    if (name.trim().toLowerCase() == handle.trim().toLowerCase()) {
      return CONF.users[name];
    }
  }
  return undefined;
}

// Create Range payloads to send to the webhookURL
// https://help.range.co/welcome/setting-up-integrations/how-to-set-up-a-custom-integration
function createRangePayloads(entries) {
  var payloads = [];
  entries.forEach(entry => {
    entry.editors.forEach(editor => {
      payloads.push({
        email_hash: crypto
          .createHash("sha1")
          .update(editor.email)
          .digest("hex"),
        is_future: false,
        reason: "EDITED",
        dedupe_strategy: "UPSERT_PENDING",
        attachment: {
          source_id: entry.file.key,
          provider: "figma",
          provider_name: "Figma",
          html_url: "https://www.figma.com/file/" + entry.file.key,
          name: entry.file.name,
          type: "DOCUMENT",
          subtype: "FIGMA_DOCUMENT"
        }
      });
    });
  });
  return Promise.resolve(payloads);
}

// Send Range payloads with no rate limiting
function sendRangePayloads(payloads) {
  var rangeRequests = payloads.map(payload => {
    return axios.post(CONF.range.webhookURL, payload);
  });
  return Promise.all(rangeRequests).then(responses => {
    responses.forEach(resp => {
      if (resp.status != 200) {
        return Promise.reject(new Error(resp));
      }
    });
    log(`Sent ${rangeRequests.length} payloads to Range`);
    return Promise.resolve();
  });
}
