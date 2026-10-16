export type IntentRoute =
  | "current_time"
  | "entity_status"
  | "entity_action"
  | "area_summary"
  | "home_presence"
  | "house_status"
  | "house_summary"
  | "event_log"
  | "person_location"
  | "calculation"
  | "time_window_math"
  | "memory_query"
  | "calendar_query"
  | "energy_budget"
  | "music_playback"
  | "alarm_clock"
  | "deferred_watch"
  | "weather_query"
  | "system_health"
  | "general_knowledge"
  | "agentic_read"
  | "open_conversation";

export type IntentConfidence = "low" | "medium" | "high";

export type ContextClaimUse = "read_followup" | "refocus" | "repeat" | "explain";
