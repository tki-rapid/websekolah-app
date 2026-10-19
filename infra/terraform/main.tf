locals {
  apis = [
    "run.googleapis.com", "sqladmin.googleapis.com", "secretmanager.googleapis.com", "artifactregistry.googleapis.com",
    "compute.googleapis.com", "servicenetworking.googleapis.com", "cloudbuild.googleapis.com", "iam.googleapis.com",
    "logging.googleapis.com", "monitoring.googleapis.com", "cloudscheduler.googleapis.com",
  ]
  repo    = "${var.region}-docker.pkg.dev/${var.project_id}/websekolah"
  db_ip   = google_sql_database_instance.pg.private_ip_address
  db_name = "websekolah"
  # Prisma's Node pg adapter follows stricter TLS verification than libpq. Cloud SQL's
  # private-IP endpoint uses an internal CA, so preserve encrypted transport while
  # selecting libpq-compatible `require` semantics for application role URLs.
  db_url = { for r, pw in local.db_pw : r => "postgresql://${r}:***@${local.db_ip}:5432/${local.db_name}?uselibpqcompat=true&sslmode=require" }
  db_pw  = { ws_migrator = random_password.mig.result, ws_tenant_app = random_password.tenant.result, ws_platform_app = random_password.platform.result }
}

resource "google_project_service" "apis" {
  for_each           = toset(local.apis)
  service            = each.value
  disable_on_destroy = false
}

# ───────────── network: Cloud SQL is private-IP only ─────────────
resource "google_compute_network" "vpc" {
  name                    = "websekolah"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}
resource "google_compute_subnetwork" "run" {
  name                     = "websekolah-run"
  region                   = var.region
  network                  = google_compute_network.vpc.id
  ip_cidr_range            = "10.20.0.0/24"
  private_ip_google_access = true
}
resource "google_compute_global_address" "sql_range" {
  name          = "websekolah-sql-range"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 20
  network       = google_compute_network.vpc.id
}
resource "google_service_networking_connection" "sql" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.sql_range.name]
}

# ───────────── PostgreSQL ─────────────
resource "random_password" "admin" {
  length  = 32
  special = false
}
resource "random_password" "mig" {
  length  = 32
  special = false
}
resource "random_password" "tenant" {
  length  = 32
  special = false
}
resource "random_password" "platform" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "pg" {
  name                = "websekolah-pg"
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = true
  depends_on          = [google_service_networking_connection.sql]

  settings {
    edition           = "ENTERPRISE"
    tier              = var.db_tier
    availability_type = var.db_high_availability ? "REGIONAL" : "ZONAL"
    disk_autoresize   = true
    disk_type         = "PD_SSD"

    ip_configuration {
      ipv4_enabled    = false
      private_network = google_compute_network.vpc.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }
    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = true # RPO well under the 24 h target (NFR05)
      start_time                     = "20:00"
      transaction_log_retention_days = 7
      backup_retention_settings { retained_backups = 30 }
    }
    maintenance_window {
      day  = 7
      hour = 19
    }
    database_flags {
      name  = "timezone"
      value = "UTC"
    }
    database_flags {
      name  = "log_min_duration_statement"
      value = "1000"
    }
    insights_config { query_insights_enabled = true }
  }
}
resource "google_sql_database" "app" {
  name     = local.db_name
  instance = google_sql_database_instance.pg.name
}
# Only the admin login is created here (needed once for the role bootstrap job). The three runtime
# roles are created by scripts/db-bootstrap.sql so they are NOT members of cloudsqlsuperuser.
resource "google_sql_user" "admin" {
  name     = "postgres"
  instance = google_sql_database_instance.pg.name
  password = random_password.admin.result
}

# ───────────── secrets ─────────────
resource "random_id" "app_secret" { byte_length = 48 }
resource "random_id" "totp_key" { byte_length = 48 }
resource "random_password" "job_runner" {
  length  = 56
  special = false
}

locals {
  generated_secrets = {
    "app-secret"       = random_id.app_secret.b64_std
    "totp-enc-key"     = random_id.totp_key.b64_std
    "db-url-tenant"    = local.db_url["ws_tenant_app"]
    "db-url-platform"  = local.db_url["ws_platform_app"]
    "db-url-migrate"   = local.db_url["ws_migrator"]
    "db-url-admin"     = "postgresql://postgres:${urlencode(random_password.admin.result)}@${local.db_ip}:5432/${local.db_name}?sslmode=require"
    "db-pw-migrator"   = random_password.mig.result
    "db-pw-tenant"     = random_password.tenant.result
    "db-pw-platform"   = random_password.platform.result
    "job-runner-token" = random_password.job_runner.result
  }
  # supplied by you after apply:  gcloud secrets versions add google-client-id --data-file=-
  # smtp-url: e.g. smtps://USER:PASS@smtp.provider.com:465 (invitations and password-reset e-mails)
  manual_secrets = ["google-client-id", "google-client-secret", "smtp-url"]
}
resource "google_secret_manager_secret" "generated" {
  for_each  = local.generated_secrets
  secret_id = each.key
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}
resource "google_secret_manager_secret_version" "generated" {
  for_each    = local.generated_secrets
  secret      = google_secret_manager_secret.generated[each.key].id
  secret_data = each.value
}
resource "google_secret_manager_secret" "manual" {
  for_each  = toset(local.manual_secrets)
  secret_id = each.value
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

# ───────────── identities (least privilege) ─────────────
resource "google_service_account" "app" {
  account_id   = "websekolah-app"
  display_name = "WebSekolah runtime"
}
resource "google_service_account" "jobs" {
  account_id   = "websekolah-jobs"
  display_name = "WebSekolah migration/bootstrap jobs"
}
locals {
  app_secrets  = ["app-secret", "totp-enc-key", "db-url-tenant", "db-url-platform", "google-client-id", "google-client-secret", "smtp-url", "job-runner-token"]
  jobs_secrets = ["db-url-migrate", "db-url-admin", "db-pw-migrator", "db-pw-tenant", "db-pw-platform"]
  all_secret_ids = merge(
    { for k, s in google_secret_manager_secret.generated : k => s.id },
    { for k, s in google_secret_manager_secret.manual : k => s.id },
  )
}
resource "google_secret_manager_secret_iam_member" "app" {
  for_each  = toset(local.app_secrets)
  secret_id = local.all_secret_ids[each.value]
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.app.email}"
}
resource "google_secret_manager_secret_iam_member" "jobs" {
  for_each  = toset(local.jobs_secrets)
  secret_id = local.all_secret_ids[each.value]
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.jobs.email}"
}

# ───────────── media bucket (private; served only through signed URLs / the app) ─────────────
resource "google_storage_bucket" "media" {
  name                        = "${var.project_id}-websekolah-media"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  versioning { enabled = true }
  lifecycle_rule {
    condition { days_since_noncurrent_time = 30 }
    action { type = "Delete" }
  }
  soft_delete_policy { retention_duration_seconds = 604800 }
  # the CMS uploads straight from the browser to a V4 signed URL: only the app origin may PUT
  cors {
    origin          = [var.app_url]
    method          = ["PUT"]
    response_header = ["Content-Type", "x-goog-content-length-range"]
    max_age_seconds = 600
  }
}
resource "google_storage_bucket_iam_member" "app_media" {
  bucket = google_storage_bucket.media.name
  role   = "roles/storage.objectUser"
  member = "serviceAccount:${google_service_account.app.email}"
}
# signed URLs are produced by the app's own service account (no key files): it signs via IAM Credentials
resource "google_service_account_iam_member" "app_self_sign" {
  service_account_id = google_service_account.app.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:${google_service_account.app.email}"
}

# ───────────── registry ─────────────
resource "google_artifact_registry_repository" "repo" {
  repository_id = "websekolah"
  format        = "DOCKER"
  location      = var.region
  depends_on    = [google_project_service.apis]
}

# ───────────── Cloud Run: jobs (bootstrap, migrate) and the app ─────────────
resource "google_cloud_run_v2_job" "bootstrap" {
  name                = "websekolah-db-bootstrap"
  location            = var.region
  deletion_protection = false
  template {
    template {
      service_account = google_service_account.jobs.email
      max_retries     = 0
      vpc_access {
        network_interfaces {
          network    = google_compute_network.vpc.id
          subnetwork = google_compute_subnetwork.run.id
        }
        egress = "PRIVATE_RANGES_ONLY"
      }
      containers {
        image = "${local.repo}/bootstrap:${var.image_tag}"
        env {
          name = "ADMIN_DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = "db-url-admin"
              version = "latest"
            }
          }
        }
        env {
          name = "MIG_PW"
          value_source {
            secret_key_ref {
              secret  = "db-pw-migrator"
              version = "latest"
            }
          }
        }
        env {
          name = "TENANT_PW"
          value_source {
            secret_key_ref {
              secret  = "db-pw-tenant"
              version = "latest"
            }
          }
        }
        env {
          name = "PLATFORM_PW"
          value_source {
            secret_key_ref {
              secret  = "db-pw-platform"
              version = "latest"
            }
          }
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.jobs]
  lifecycle { ignore_changes = [template[0].template[0].containers[0].image] }
}

resource "google_cloud_run_v2_job" "migrate" {
  name                = "websekolah-migrate"
  location            = var.region
  deletion_protection = false
  template {
    template {
      service_account = google_service_account.jobs.email
      max_retries     = 0
      vpc_access {
        network_interfaces {
          network    = google_compute_network.vpc.id
          subnetwork = google_compute_subnetwork.run.id
        }
        egress = "PRIVATE_RANGES_ONLY"
      }
      containers {
        image = "${local.repo}/migrate:${var.image_tag}"
        env {
          name = "DATABASE_URL_MIGRATE"
          value_source {
            secret_key_ref {
              secret  = "db-url-migrate"
              version = "latest"
            }
          }
        }
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.jobs]
  lifecycle { ignore_changes = [template[0].template[0].containers[0].image] }
}

resource "google_cloud_run_v2_service" "app" {
  name                = "websekolah-app"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = true

  template {
    service_account                  = google_service_account.app.email
    max_instance_request_concurrency = 40
    timeout                          = "30s"
    scaling {
      min_instance_count = var.app_min_instances
      max_instance_count = var.app_max_instances
    }
    vpc_access {
      network_interfaces {
        network    = google_compute_network.vpc.id
        subnetwork = google_compute_subnetwork.run.id
      }
      egress = "PRIVATE_RANGES_ONLY" # only DB traffic goes through the VPC; Google/Auth endpoints use the public path
    }
    containers {
      image = "${local.repo}/app:${var.image_tag}"
      ports { container_port = 8080 }
      resources {
        limits            = { cpu = "1", memory = "1Gi" }
        cpu_idle          = true
        startup_cpu_boost = true
      }
      env {
        name  = "APP_URL"
        value = var.app_url
      }
      env {
        name  = "PLATFORM_DOMAIN"
        value = var.platform_domain
      }
      env {
        name  = "MEDIA_BACKEND"
        value = "gcs"
      }
      env {
        name  = "MEDIA_BUCKET"
        value = google_storage_bucket.media.name
      }
      env {
        name  = "MAIL_FROM"
        value = var.mail_from
      }
      env {
        name  = "TRUSTED_PROXY_HOPS"
        value = "1" # Cloud Run appends the real client IP; raise to 2 behind a Google HTTPS load balancer
      }
      dynamic "env" {
        for_each = {
          APP_SECRET            = "app-secret"
          TOTP_ENC_KEY          = "totp-enc-key"
          DATABASE_URL_TENANT   = "db-url-tenant"
          DATABASE_URL_PLATFORM = "db-url-platform"
          GOOGLE_CLIENT_ID      = "google-client-id"
          GOOGLE_CLIENT_SECRET  = "google-client-secret"
          SMTP_URL              = "smtp-url"
          JOB_RUNNER_TOKEN      = "job-runner-token"
        }
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = env.value
              version = "latest"
            }
          }
        }
      }
      startup_probe {
        http_get { path = "/api/health" }
        initial_delay_seconds = 2
        period_seconds        = 3
        failure_threshold     = 20
      }
      liveness_probe {
        http_get { path = "/api/health" }
        period_seconds = 30
      }
    }
  }
  depends_on = [google_secret_manager_secret_iam_member.app]
  lifecycle { ignore_changes = [template[0].containers[0].image, client, client_version] }
}

# The app is public (it serves school websites); authorisation happens inside the app.
resource "google_cloud_run_v2_service_iam_member" "public" {
  name     = google_cloud_run_v2_service.app.name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# ───────────── worker tick: e-mail queue, expired upload reservations, rate-limit purge ─────────────
resource "google_cloud_scheduler_job" "jobs" {
  name             = "websekolah-jobs"
  region           = var.region
  schedule         = "* * * * *"
  time_zone        = "Etc/UTC"
  attempt_deadline = "300s"
  retry_config { retry_count = 1 }
  http_target {
    http_method = "POST"
    uri         = "${var.app_url}/api/internal/jobs/run"
    headers     = { Authorization = "Bearer ${random_password.job_runner.result}" }
  }
  depends_on = [google_project_service.apis]
}
