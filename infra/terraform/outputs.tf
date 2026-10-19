output "app_url_default" { value = google_cloud_run_v2_service.app.uri }
output "artifact_registry" { value = local.repo }
output "cloud_sql_private_ip" { value = google_sql_database_instance.pg.private_ip_address }
output "media_bucket" { value = google_storage_bucket.media.name }
output "google_oauth_redirect_uri" {
  value       = "${var.app_url}/api/auth/google/callback"
  description = "Add this as an Authorized redirect URI on your Google OAuth client."
}
