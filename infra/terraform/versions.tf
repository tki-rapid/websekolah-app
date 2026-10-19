terraform {
  required_version = ">= 1.6"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # Keep state in a private, versioned GCS bucket with restricted IAM — it contains generated secrets.
  # backend "gcs" { bucket = "YOUR-TFSTATE-BUCKET", prefix = "websekolah" }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
