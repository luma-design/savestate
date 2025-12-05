# Incognito Tab Saver - v1.0.0

A Chrome extension that saves and restores incognito browsing sessions on Android and desktop browsers, with a beautiful night sky theme.

## Quick Start (5 minutes)

1. **Generate Icons**
   - Open `icon-generator.html` in your browser
   - Click "Download" for each icon size
   - Save to the `icons/` folder (icon16.png, icon32.png, icon48.png, icon128.png)

2. **Load Extension**
   - Go to `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select this folder
   - Grant incognito permission

3. **Test**
   - Open incognito mode
   - Browse to some websites
   - Click extension icon to see saved tabs
   - Try "Restore" to reopen a session

## File Structure

```
quicksave/
├── manifest.json              ✓ Extension config
├── background.js              ✓ Core logic (346 lines)
├── icon-generator.html        ✓ Tool to create icons
├── icons/                     → Create this folder
│   ├── icon16.png            → Generate from tool
│   ├── icon32.png            → Generate from tool
│   ├── icon48.png            → Generate from tool
│   └── icon128.png           → Generate from tool
└── ui/
    ├── popup.html            ✓ Main popup
    ├── popup.css             ✓ Popup styling
    ├── popup.js              ✓ Popup logic
    ├── options.html          ✓ Settings page
    ├── options.css           ✓ Settings styling
    ├── options.js            ✓ Settings logic
    └── onboarding.html       ✓ Welcome screen
```

## Features

✓ Auto-save incognito tabs
✓ Session grouping
✓ One-click restore
✓ Export/import sessions
✓ Search & filter
✓ Night sky theme with stars
✓ Mobile optimized
✓ Local storage only (privacy)

## Troubleshooting

**Extension icon not showing?**
- Ensure all 4 PNG files are in `icons/` folder
- Check file names: icon16.png, icon32.png, icon48.png, icon128.png
- Reload extension

**Tabs not saving?**
- Verify extension has incognito permission
- Check chrome://extensions/ Details page
- Grant incognito access if needed

**Popup blank?**
- Verify all files exist in `ui/` folder
- Check console for errors
- Reload extension

## Theme Colors

The extension uses a beautiful night sky theme:
- Night Sky: #0a0e27
- Star Blue: #4a90e2
- Moon Glow: #6c9bcf
- Comet Tail: #8ab4f8

Easy to customize in `popup.css` and `options.css`

## Chrome Web Store (Optional)

To publish to Chrome Web Store:
1. Create developer account (chromewebstore.google.com)
2. Zip this folder
3. Upload ZIP file
4. Fill in listing details
5. Submit for review (24-72 hours)

## Support

- Check README files
- Review code comments
- Check console for errors
- Visit Chrome Extension API docs: https://developer.chrome.com/docs/extensions/

## Version

v1.0.0 - October 2025
Production Ready ✓

## License

MIT License - Free to use and modify

---

Made with ❤️ for incognito browsing
