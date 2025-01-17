//! A parser for the configuration file.
// Here we can crash as we cannot proceed with an invalid config.
#![allow(clippy::expect_used)]

use crate::config::Config;
use clap::{AppSettings, Clap};
use slog::Level;
use std::{fs::File, io, path::PathBuf};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum CliError {
    #[error("{0}")]
    Io(io::Error),
    #[error("An error occurred while deserialized the provided configuration: {0}")]
    Deserialize(String),
}

/// This struct is use to provide a command line interface to the adapter.
#[derive(Clap)]
#[clap(version = "0.0.0", author = "DFINITY team <team@dfinity.org>")]
#[clap(setting = AppSettings::ColoredHelp)]
pub struct Cli {
    /// This field contains the path to the config file.
    pub config: PathBuf,

    #[clap(short, long)]
    /// This field represents if the adapter should run in verbose.
    pub verbose: bool,
}

impl Cli {
    /// Gets the log filter level by checking the verbose field.
    pub fn get_logging_level(&self) -> Level {
        if self.verbose {
            Level::Debug
        } else {
            Level::Info
        }
    }

    /// Loads the config from the provided `config` argument.
    pub fn get_config(&self) -> Result<Config, CliError> {
        // The expected JSON config.
        let file = File::open(&self.config).map_err(CliError::Io)?;
        serde_json::from_reader(file).map_err(|err| CliError::Deserialize(err.to_string()))
    }
}

#[cfg(test)]
pub mod test {
    use super::*;
    use crate::config;
    use std::io::Write;
    use std::str::FromStr;
    use tempfile::NamedTempFile;

    /// This function tests the `Cli::get_logging_level()` function.
    #[test]
    fn test_cli_get_logging_level() {
        let cli = Cli {
            config: PathBuf::new(),
            verbose: false,
        };

        assert_eq!(cli.get_logging_level(), Level::Info);

        let cli = Cli {
            config: PathBuf::new(),
            verbose: true,
        };

        assert_eq!(cli.get_logging_level(), Level::Debug);
    }

    // This function tests opening a config file that does not exist.
    #[test]
    fn test_cli_get_config_error_opening_file() {
        let cli = Cli {
            config: PathBuf::from_str("/tmp/http-adapter-test.json").expect("Bad file path string"),
            verbose: true,
        };
        let result = cli.get_config();
        assert!(result.is_err());
        let error = result.unwrap_err();
        assert!(matches!(error, CliError::Io(_)));
    }

    // This function tests using a invalid JSON file.
    #[test]
    fn test_cli_get_config_bad_json() {
        let json = r#"{asdf"#;

        let mut tmpfile = NamedTempFile::new().expect("Failed to create tmp file");
        writeln!(tmpfile, "{}", json).expect("Failed to write to tmp file");

        // should use the default values
        let cli = Cli {
            config: tmpfile.path().to_owned(),
            verbose: true,
        };
        let result = cli.get_config();
        assert!(result.is_err());
        let error = result.unwrap_err();
        let matches = match error {
            CliError::Deserialize(message) => message == "key must be a string at line 1 column 2",
            _ => false,
        };
        assert!(matches);
    }

    // This function tests an empty json file. In this case there should be fallback to the default values.
    #[test]
    fn test_cli_get_config_empty_json() {
        let json = r#"{}"#;

        let mut tmpfile = NamedTempFile::new().expect("Failed to create tmp file");
        writeln!(tmpfile, "{}", json).expect("Failed to write to tmp file");

        // should use the default values
        let cli = Cli {
            config: tmpfile.path().to_owned(),
            verbose: true,
        };
        let result = cli.get_config();
        let config = result.unwrap();
        assert_eq!(
            config.http_connect_timeout_secs,
            config::default_http_connect_timeout_secs()
        );
        assert_eq!(
            config.http_request_timeout_secs,
            config::default_http_request_timeout_secs()
        );
        assert_eq!(
            config.http_request_size_limit_bytes,
            config::default_http_request_size_limit_bytes()
        );
    }

    // This function tests having an unknown field in the JSON. The unknown field is ignored and it falls back to the defaults.
    #[test]
    fn test_cli_get_config_unknown_field_json() {
        let json = r#"{
            "unknown": "unknown"
        }"#;

        let mut tmpfile = NamedTempFile::new().expect("Failed to create tmp file");
        writeln!(tmpfile, "{}", json).expect("Failed to write to tmp file");

        let cli = Cli {
            config: tmpfile.path().to_owned(),
            verbose: true,
        };
        let result = cli.get_config();
        let config = result.unwrap();
        assert_eq!(
            config.http_connect_timeout_secs,
            config::default_http_connect_timeout_secs()
        );
        assert_eq!(
            config.http_request_timeout_secs,
            config::default_http_request_timeout_secs()
        );
        assert_eq!(
            config.http_request_size_limit_bytes,
            config::default_http_request_size_limit_bytes()
        );
    }

    // This function tests a fully specified config file. It overwrites all default values.
    #[test]
    fn test_cli_get_full_config_json() {
        let json = r#"
        {
            "http_connect_timeout_secs": 3,
            "http_request_timeout_secs": 10,
            "http_request_size_limit_bytes": 1073741824
        }       
        "#;

        let mut tmpfile = NamedTempFile::new().expect("Failed to create tmp file");
        writeln!(tmpfile, "{}", json).expect("Failed to write to tmp file");

        // should use the default values
        let cli = Cli {
            config: tmpfile.path().to_owned(),
            verbose: true,
        };
        let result = cli.get_config();
        let config = result.unwrap();
        assert_eq!(config.http_connect_timeout_secs, 3);
        assert_eq!(config.http_request_timeout_secs, 10);
        assert_eq!(config.http_request_size_limit_bytes, 1073741824);
    }
}
