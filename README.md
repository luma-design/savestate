# SaveState Extension

## Description

SaveState is a Chrome extension designed to help users save and restore incognito browsing sessions. It provides a convenient way to manage multiple private browsing contexts, allowing you to pick up exactly where you left off without losing your open tabs.

## Features

- Save current incognito window as a named session.
- Restore a saved session, opening all tabs in a new incognito window.
- View and manage (rename, delete) saved sessions.
- Simple and intuitive user interface with a night sky theme.
- Smooth scrolling with a fixed background gradient that extends across the entire viewport.

## Installation

To install SaveState:

1. Clone the repository:
   ```bash
   git clone https://github.com/luma-design/savestate.git
   ```
2. Open Chrome and navigate to `chrome://extensions`.
3. Enable "Developer mode" by toggling the switch in the top right corner.
4. Click "Load unpacked" and select the cloned `savestate` directory.
5. The extension will now be active and visible in your browser's toolbar.

## Usage

1. Click the SaveState extension icon in your Chrome toolbar.
2. To save the current incognito window, enter a session name and click "Save Session".
3. To restore a session, select it from the list and click "Restore".
4. To rename or delete a session, use the respective options next to the session name.

## Development

### Prerequisites

- Node.js (for running tests and managing development dependencies)

### Setup

1. Install dependencies:
   ```bash
   npm install
   ```

### Testing

SaveState uses `vitest` for testing. You can run tests with:

```bash
npm test
```

For continuous testing during development:

```bash
npm run test:watch
```

## Contributing

We welcome contributions to SaveState! If you'd like to contribute, please follow these steps:

1. Fork the repository.
2. Create a new branch for your feature or bug fix.
3. Make your changes and ensure they adhere to the existing code style.
4. Write tests for your changes.
5. Submit a pull request with a clear description of your changes.

## License

This project is licensed under the MIT License. See the `LICENSE` file for details. (Note: A `LICENSE` file is not currently present, but will be added if needed.)
