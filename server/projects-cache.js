/**
 * PROJECTS CACHE MODULE
 * =====================
 *
 * In-memory cache for projects data with ETag support.
 * Updated by the chokidar watcher when project files change.
 * Mirrors the sessions-cache.js pattern for consistency.
 */

import crypto from "crypto";

// Cache state
let cachedProjects = [];
let cacheVersion = 0;
let cacheTimestamp = null;

// Promise-based initialization waiting
let initResolvers = [];
const MAX_WAIT_MS = 30000; // 30 second timeout

/**
 * Timeframe definitions in milliseconds
 * (Same as sessions-cache.js for consistency)
 */
const TIMEFRAME_MS = {
  "1h": 60 * 60 * 1000,
  "8h": 8 * 60 * 60 * 1000,
  "1d": 24 * 60 * 60 * 1000,
  "1w": 7 * 24 * 60 * 60 * 1000,
  "2w": 14 * 24 * 60 * 60 * 1000,
  "1m": 30 * 24 * 60 * 60 * 1000,
  all: Infinity,
};

/**
 * Calculate last activity timestamp for a project
 * Based on the most recent session across all providers
 */
function calculateLastActivity(project) {
  let lastActivity = null;

  // Check Claude sessions
  if (project.sessions && project.sessions.length > 0) {
    for (const session of project.sessions) {
      const sessionDate = new Date(session.lastActivity);
      if (!lastActivity || sessionDate > lastActivity) {
        lastActivity = sessionDate;
      }
    }
  }

  // Check Cursor sessions
  if (project.cursorSessions && project.cursorSessions.length > 0) {
    for (const session of project.cursorSessions) {
      const sessionDate = new Date(session.createdAt || session.lastActivity);
      if (!lastActivity || sessionDate > lastActivity) {
        lastActivity = sessionDate;
      }
    }
  }

  // Check Codex sessions
  if (project.codexSessions && project.codexSessions.length > 0) {
    for (const session of project.codexSessions) {
      const sessionDate = new Date(session.lastActivity || session.createdAt);
      if (!lastActivity || sessionDate > lastActivity) {
        lastActivity = sessionDate;
      }
    }
  }

  return lastActivity ? lastActivity.toISOString() : null;
}

/**
 * Transform full project data to slim format
 */
function toSlimProject(project) {
  // Support both DB-sourced data (sessionCount already computed) and
  // full filesystem data (sessions/cursorSessions/codexSessions arrays)
  let sessionCount;
  let claudeCount, cursorCount, codexCount;

  if (typeof project.sessionCount === "number") {
    // DB-sourced data already has sessionCount from subquery
    sessionCount = project.sessionCount;
    claudeCount = project.hasClaudeSessions ? 1 : 0;
    cursorCount = project.hasCursorSessions ? 1 : 0;
    codexCount = project.hasCodexSessions ? 1 : 0;
  } else {
    // Full filesystem data with session arrays
    claudeCount = project.sessions?.length || 0;
    cursorCount = project.cursorSessions?.length || 0;
    codexCount = project.codexSessions?.length || 0;
    sessionCount = claudeCount + cursorCount + codexCount;
  }

  return {
    name: project.name,
    displayName: project.displayName,
    fullPath: project.fullPath || project.path,
    sessionCount,
    lastActivity: project.lastActivity || calculateLastActivity(project),
    hasClaudeSessions: project.hasClaudeSessions ?? claudeCount > 0,
    hasCursorSessions: project.hasCursorSessions ?? cursorCount > 0,
    hasCodexSessions: project.hasCodexSessions ?? codexCount > 0,
    hasTaskmaster: project.hasTaskmaster ?? project.taskmaster?.hasTaskmaster ?? false,
    sessionMeta: project.sessionMeta,
    isManuallyAdded: project.isManuallyAdded || false,
    isCustomName: project.isCustomName || false,
  };
}

/**
 * Update the projects cache from full projects data
 * Called after getProjects() completes
 */
function updateProjectsCache(projects) {
  // Transform to slim format
  cachedProjects = projects.map(toSlimProject);

  // Sort by lastActivity descending (most recent first)
  cachedProjects.sort((a, b) => {
    const dateA = a.lastActivity ? new Date(a.lastActivity) : new Date(0);
    const dateB = b.lastActivity ? new Date(b.lastActivity) : new Date(0);
    return dateB - dateA;
  });

  cacheVersion++;
  cacheTimestamp = new Date().toISOString();

  // Resolve any waiting promises
  if (initResolvers.length > 0) {
    for (const resolve of initResolvers) {
      resolve();
    }
    initResolvers = [];
  }
}

/**
 * Get projects filtered by timeframe
 * Projects are included if their lastActivity is within the timeframe
 */
function getProjectsByTimeframe(timeframe = "1w") {
  const now = Date.now();
  const cutoffMs = TIMEFRAME_MS[timeframe] || TIMEFRAME_MS["1w"];

  if (cutoffMs === Infinity) {
    return {
      projects: cachedProjects,
      totalCount: cachedProjects.length,
      filteredCount: cachedProjects.length,
    };
  }

  const cutoffTime = now - cutoffMs;
  const filteredProjects = cachedProjects.filter((project) => {
    if (!project.lastActivity) {
      return false; // Exclude projects with no sessions
    }
    const projectTime = new Date(project.lastActivity).getTime();
    return projectTime >= cutoffTime;
  });

  return {
    projects: filteredProjects,
    totalCount: cachedProjects.length,
    filteredCount: filteredProjects.length,
  };
}

/**
 * Generate ETag for current cache state + timeframe
 */
function generateETag(timeframe = "1w") {
  const hash = crypto.createHash("md5");
  hash.update(`projects-${cacheVersion}-${cacheTimestamp}-${timeframe}`);
  return `"${hash.digest("hex")}"`;
}

/**
 * Get cache metadata
 */
function getCacheMeta() {
  return {
    version: cacheVersion,
    timestamp: cacheTimestamp,
    projectCount: cachedProjects.length,
  };
}

/**
 * Check if cache is initialized
 */
function isCacheInitialized() {
  return cacheTimestamp !== null;
}

/**
 * Wait for cache to be initialized
 * Returns immediately if already initialized, otherwise waits up to MAX_WAIT_MS
 */
function waitForInitialization() {
  if (cacheTimestamp !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      // Remove this resolver from the list
      const idx = initResolvers.indexOf(resolve);
      if (idx !== -1) {
        initResolvers.splice(idx, 1);
      }
      reject(new Error("Cache initialization timeout"));
    }, MAX_WAIT_MS);

    // Wrap resolver to clear timeout
    const wrappedResolve = () => {
      clearTimeout(timeout);
      resolve();
    };

    initResolvers.push(wrappedResolve);
  });
}

/**
 * Get the raw cached projects (for initial load)
 */
function getCachedProjects() {
  return cachedProjects;
}

/**
 * Get a single project from cache by name
 */
function getProjectFromCache(projectName) {
  return cachedProjects.find((p) => p.name === projectName) || null;
}

export {
  updateProjectsCache,
  getProjectsByTimeframe,
  generateETag,
  getCacheMeta,
  isCacheInitialized,
  waitForInitialization,
  getCachedProjects,
  getProjectFromCache,
  TIMEFRAME_MS,
};
