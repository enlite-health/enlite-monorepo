# Sabotage: references an mcp-token secret.
data "google_secret_manager_secret" "sabotage" {
  secret_id = "mcp-token-assistant"
}
