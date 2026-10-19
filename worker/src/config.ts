// Settings, transport constants, and result caps. Mirrors src/hevy_mcp/config.py;
// see that module for where each value comes from (the hevy-unofficial package,
// and probing the live API).

// --- Your settings ------------------------------------------------------------
// Set these for your own account (the README's setup guide walks through them),
// and keep them in step with src/hevy_mcp/config.py.

// Your time zone. Workout times are stored and shown in it, and a workout's date
// is its local start date: in UTC an evening session lands on the next day.
// Hevy's payloads carry no zone.
export const TIMEZONE = "America/Chicago";

// Your bodyweight as set in Hevy's profile. Hevy adds it to the volume of
// bodyweight exercises (pull ups, dips, assisted variants), and only this makes
// volume_kg match Hevy's own totals. See config.py for how it was derived.
export const BODYWEIGHT_KG = 63.5;

// --------------------------------------------------------------------------------

export const VERSION = "0.2.0";

export const BASE_URL = "https://api.hevyapp.com";
export const WEB_ORIGIN = "https://hevy.com";

export const API_KEY = "shelobs_hevy_web";
export const PLATFORM = "web";
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36";
export const ACCEPT = "application/json, text/plain, */*";
export const ACCEPT_LANGUAGE = "en-US,en;q=0.8";

export const EP_ACCOUNT = "/user/account";
export const EP_WORKOUTS_PAGED = "/user_workouts_paged";
export const EP_REFRESH = "/auth/refresh_token";

// /user_workouts_paged rejects limit > 5 with HTTP 400.
export const MAX_PAGE_SIZE = 5;
export const PAGE_SIZE = 5;

// The free Workers plan allows 50 outbound fetches per invocation. A sync stops
// short of that and resumes from where it left off on the next run.
export const MAX_PAGES_PER_RUN = 40;

// A sync holds this lease so a cron run and a sync_workouts call never refresh
// the Hevy token at the same time; Hevy rotates it on every refresh.
export const SYNC_LEASE_SECONDS = 120;

export const MAX_WORKOUTS = 200;
export const DEFAULT_WORKOUTS = 50;
export const MAX_EXERCISE_HISTORY_SETS = 500;
export const MAX_VOLUME_BUCKETS = 200;
export const MAX_EXERCISES = 300;
export const MAX_PRS = 200;

// Exercises where Hevy credits the full bodyweight; see config.py.
export const FULL_BODYWEIGHT_TEMPLATES = new Set(["1B2B1E7C", "28BB4A95"]);
export const ASSISTED_EXERCISE_TYPE = "bodyweight_assisted_reps";

export const FUZZY_THRESHOLD = 0.6;

// Routines. Free Hevy accounts hold at most 4; the web editor enforces it and
// so do we, rather than leaning on whatever the API happens to allow.
export const FREE_ROUTINE_LIMIT = 4;
export const DEFAULT_REST_SECONDS = 90;
// Hevy's app converts with this divisor (135 lb -> 61.23504277381136 kg), so
// weights written with it show as round pounds in the app.
export const KG_PER_LB_DIVISOR = 2.20462;
export const METERS_PER_MILE = 1609.344;
