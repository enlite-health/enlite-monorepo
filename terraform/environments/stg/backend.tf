terraform {
  backend "gcs" {
    bucket = "enlite-tf-state"
    prefix = "stg"
  }
}
