variable "project_id" { type = string }
variable "region" {
  type    = string
  default = "asia-southeast2" # Jakarta
}
variable "app_url" {
  type        = string
  description = "Public https origin of the platform app, e.g. https://app.websekolah.id (OAuth redirect + CSRF origin)."
  validation {
    condition     = startswith(var.app_url, "https://")
    error_message = "app_url must be https://"
  }
}
variable "platform_domain" {
  type    = string
  default = "websekolah.id"
}
variable "db_tier" {
  type    = string
  default = "db-custom-2-7680" # ~100 tenants fits comfortably; scale up after the load test (NFR01)
}
variable "db_high_availability" {
  type    = bool
  default = true
}
variable "app_min_instances" {
  type    = number
  default = 1
}
variable "app_max_instances" {
  type    = number
  default = 10
}
variable "image_tag" {
  type        = string
  default     = "bootstrap"
  description = "Image tag deployed by Terraform on first apply; Cloud Build deploys real tags afterwards."
}
variable "mail_from" {
  type    = string
  default = "WebSekolah <no-reply@websekolah.id>"
}
