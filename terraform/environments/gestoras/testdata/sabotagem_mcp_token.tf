# Sabotagem: referencia a um secret mcp-token.
data "google_secret_manager_secret" "sabotagem" {
  secret_id = "mcp-token-gestora"
}
