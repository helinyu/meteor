var main = require('./main.js');
var path = require('path');
var _ = require('underscore');
var fs = require('fs');
var files = require('./files.js');
var buildmessage = require('./buildmessage.js');
var project = require('./project.js').project;
var auth = require('./auth.js');
var config = require('./config.js');
var release = require('./release.js');
var Future = require('fibers/future');
var runLog = require('./run-log.js');
var packageClient = require('./package-client.js');
var utils = require('./utils.js');
var archinfo = require('./archinfo.js');
var tropohouse = require('./tropohouse.js');
var packageCache = require('./package-cache.js');
var packageLoader = require('./package-loader.js');
var PackageSource = require('./package-source.js');
var compiler = require('./compiler.js');
var unipackage = require('./unipackage.js');
var execFileSync = require('./utils.js').execFileSync;
var execFileAsync = require('./utils.js').execFileAsync;

var cordova = exports;

var supportedPlatforms = ['ios', 'android', 'firefoxos'];

var getLoadedPackages = _.once(function () {
  var uniload = require('./uniload.js');
  return uniload.load({
    packages: [ 'boilerplate-generator' ]
  });
});

var generateCordovaBoilerplate = function (clientDir, options) {
  var clientJsonPath = path.join(clientDir, 'program.json');
  var clientJson = JSON.parse(fs.readFileSync(clientJsonPath, 'utf8'));

  var manifest = _.map(clientJson.manifest, function (item) {
    if (item.type === 'js')
      return _.extend(item, { url: ('/js' + item.url) });
    return item;
  });

  var meteorRelease = project.getMeteorReleaseVersion();
  var Boilerplate = getLoadedPackages()['boilerplate-generator'].Boilerplate;
  var boilerplate = new Boilerplate('web.cordova', manifest, {
    urlMapper: function (url) { return url ? url.substr(1) : ''; },
    pathMapper: function (p) { return path.join(clientDir, p); },
    baseDataExtension: {
      includeCordova: true,
      meteorRuntimeConfig: JSON.stringify({
        meteorRelease: meteorRelease,
        ROOT_URL: 'http://' + options.host + ':' + options.port + '/',
        // XXX propagate it from options?
        ROOT_URL_PATH_PREFIX: '',
        DDP_DEFAULT_CONNECTION_URL: 'http://' + options.host + ':' + options.port
      })
    }
  });
  return boilerplate.toHTML();
};

var fetchCordovaPluginFromShaUrl =
  function (urlWithSha, localPluginsDir, pluginName) {
  var pluginPath = path.join(localPluginsDir, pluginName);
  var pluginTarballPath = pluginPath + '.tgz';
  var curlProcess =
    execFileSync('curl', ['-L', urlWithSha, '-o', pluginTarballPath]);

  if (! curlProcess.success)
    throw new Error("Failed to fetch the tarball from " + urlWithSha + ": " +
                    curlProcess.stderr);

  files.mkdir_p(pluginPath);
  var tarProcess = execFileSync('tar',
    ['xf', pluginTarballPath, '-C', pluginPath, '--strip-components=1']);
  if (! tarProcess.success)
    throw new Error("Failed to untar the tarball from " + urlWithSha + ": " +
                    tarProcess.stderr);
  files.rm_recursive(pluginTarballPath);
  return pluginPath;
};

var checkIsValidPlugin = function (name) {
  var pluginHash = {};
  pluginHash[name.split('@')[0]] = name.split('@')[1];

  // check that every plugin is specifying either an exact constraint or a
  // tarball url with sha
  utils.ensureOnlyExactVersions(pluginHash);
};

var getBundle = function (bundlePath, webArchs) {
  var bundler = require(path.join(__dirname, 'bundler.js'));

  var bundleResult = bundler.bundle({
    outputPath: bundlePath,
    buildOptions: {
      minify: false, // XXX ! options.debug,
      arch: archinfo.host(),
      webArchs: webArchs
    }
  });

  if (bundleResult.errors) {
    throw new Error("Errors prevented bundling:\n" +
                    bundleResult.errors.formatMessages());
  }

  return bundleResult;
};

var localPluginsPathFromCordovaPath = function (cordovaPath) {
  return path.join(cordovaPath, 'local-plugins');
};

////////////////////////////////////////////////////////////////////////////////
// ensureCordova
////////////////////////////////////////////////////////////////////////////////

// Creates a Cordova project if necessary. Then synchronizes app-level plugins
// and platofrms.
cordova.ensureCordovaProject = function (localPath, appName) {
  var cordovaPath = path.join(localPath, 'cordova-build');
  var localPluginsPath = localPluginsPathFromCordovaPath(cordovaPath);
  if (! fs.existsSync(cordovaPath)) {
    try {
      execFileSync('cordova', ['create', path.basename(cordovaPath),
                               'com.meteor.' + appName,
                               appName.replace(/\s/g, '')],
                   { cwd: path.dirname(cordovaPath) });

      // create a folder for storing local plugins
      // XXX cache them there
      files.mkdir_p(localPluginsPath);
    } catch (err) {
      process.stderr.write("Error creating Cordova project: " +
        err.message + "\n");
    }
  }
};

// Ensures that the Cordova platforms are synchronized with the app-level
// platforms.
cordova.ensureCordovaPlatforms = function (localPath) {
  var cordovaPath = path.join(localPath, 'cordova-build');
  var platforms = project.getCordovaPlatforms();
  var platformsOutput = execFileSync('cordova', ['platform', 'list'],
                                     { cwd: cordovaPath }).stdout;

  var installedPlatforms = _.map(platformsOutput.split('\n')[0].match(/Installed platforms: (.*)/)[1].split(', '), function (s) { return s.split(' ')[0]; });

  _.each(platforms, function (platform) {
    if (! _.contains(installedPlatforms, platform) &&
          _.contains(supportedPlatforms, platform))
      execFileSync('cordova', ['platform', 'add', platform], { cwd: cordovaPath });
  });

  _.each(installedPlatforms, function (platform) {
    if (! _.contains(platforms, platform) &&
          _.contains(supportedPlatforms, platform))
      execFileSync('cordova', ['platform', 'rm', platform], { cwd: cordovaPath });
  });

  return true;
};

// Ensures that the Cordova platforms are synchronized with the app-level
// platforms.
// options
//   - packagePlugins: the list of plugins required by packages. If not defined,
//                     we bundle the app to find the required plugins.

cordova.ensureCordovaPlugins = function (localPath, options) {
  options = options || {};

  var plugins = options.packagePlugins;
  if (! plugins) {
    // Bundle to gather the plugin dependencies from packages.
    // XXX slow - perhaps we should only do this lazily
    // XXX code copied from buildCordova
    var bundlePath = path.join(localPath, 'build-tar');
    var webArchName = 'web.cordova';
    plugins =
      getBundle(bundlePath, [webArchName]).starManifest.cordovaDependencies;
    files.rm_recursive(bundlePath);
  }
  // XXX the project-level cordova plugins deps override the package-level ones
  _.extend(plugins, project.getCordovaPlugins());

  var cordovaPath = path.join(localPath, 'cordova-build');
  var localPluginsPath = localPluginsPathFromCordovaPath(cordovaPath);
  var newSettings = options.settings || {};

  // XXX compare the latest used sha's with the currently required sha's for
  // plugins fetched from a github/tarball url.
  var pluginsOutput = execFileSync('cordova', ['plugin', 'list'],
                                   { cwd: cordovaPath }).stdout;

  var installedPlugins = {};
  // Check if there are any plugins
  if (! pluginsOutput.match(/No plugins added/)) {
    _.each(pluginsOutput.split('\n'), function (line) {
      line = line.trim();
      if (line === '')
        return;
      var plugin = line.split(' ')[0];
      var version = line.split(' ')[1];
      installedPlugins[plugin] = version;
    });
  }

  var oldSettings = {};
  try {
    fs.readFileSync(path.join(cordovaPath, 'cordova-settings.json'), "utf8");
  } catch(err) {
    if (err.code !== "ENOENT")
      throw err;
  }

  _.each(plugins, function (version, name) {
    // no-op if this plugin is already installed
    if (_.has(installedPlugins, name)
        && installedPlugins[name] === version
        && _.isEqual(oldSettings[name], newSettings[name]))
      return;

    if (_.has(installedPlugins, name))
      execFileSync('cordova', ['plugin', 'rm', name], { cwd: cordovaPath });

    // XXX do something different for plugins fetched from a url.
    var pluginInstallCommand = version ? name + '@' + version : name;

    if (version && utils.isUrlWithSha(version)) {
      pluginInstallCommand =
        fetchCordovaPluginFromShaUrl(version, localPluginsPath, name);
    }

    var additionalArgs = [];
    // XXX how do we get settings to work now? Do we require settings to be
    // passed every time we add a plugin?
    if (newSettings[name]) {
      if (! _.isObject(newSettings[name]))
        throw new Error("Meteor.settings.cordova." + name + " is expected to be an object");
      _.each(newSettings[name], function (value, variable) {
        additionalArgs.push("--variable");
        additionalArgs.push(variable + "=" + JSON.stringify(value));
      });
    }

    var execRes = execFileSync('cordova',
       ['plugin', 'add', pluginInstallCommand].concat(additionalArgs), { cwd: cordovaPath });
    if (! execRes.success)
      throw new Error("Failed to install plugin " + name + ": " + execRes.stderr);
  });

  _.each(installedPlugins, function (version, name) {
    if (! _.has(plugins, name))
      execFileSync('cordova', ['plugin', 'rm', name], { cwd: cordovaPath });
  });
};

// Build a Cordova project, creating a Cordova project if necessary.
cordova.buildCordova = function (localPath, options) {
  var webArchName = "web.cordova";

  var bundlePath = path.join(localPath, 'build-cordova-temp');
  var programPath = path.join(bundlePath, 'programs');

  var cordovaPath = path.join(localPath, 'cordova-build');
  var wwwPath = path.join(cordovaPath, "www");
  var cordovaProgramPath = path.join(programPath, webArchName);
  var cordovaProgramAppPath = path.join(cordovaProgramPath, 'app');

  var bundle = getBundle(bundlePath, [webArchName]);

  cordova.ensureCordovaProject(localPath, options.appName);
  cordova.ensureCordovaPlatforms(localPath);
  cordova.ensureCordovaPlugins(localPath, _.extend(options, {
    packagePlugins: bundle.starManifest.cordovaDependencies
  }));

  // XXX hack, copy files from app folder one level up
  if (fs.existsSync(cordovaProgramAppPath)) {
    files.cp_r(cordovaProgramAppPath, cordovaProgramPath);
    files.rm_recursive(cordovaProgramAppPath);
  }

  // rewrite the www folder
  files.rm_recursive(wwwPath);
  files.cp_r(cordovaProgramPath, wwwPath);

  // clean up the temporary bundle directory
  files.rm_recursive(bundlePath);

  // generate index.html
  var indexHtml = generateCordovaBoilerplate(wwwPath, options);
  fs.writeFileSync(path.join(wwwPath, 'index.html'), indexHtml, 'utf8');

  var loaderPath = path.join(__dirname, 'client', 'meteor_cordova_loader.js');
  var loaderCode = fs.readFileSync(loaderPath);
  fs.writeFileSync(path.join(wwwPath, 'meteor_cordova_loader.js'), loaderCode);

  // Give the buffer more space as the output of the build is really huge
  execFileSync('cordova', ['build'],
               { cwd: cordovaPath, maxBuffer: 2000*1024 });
};

// Start the simulator or physical device for a specific platform.
// platformName is of the form ios/ios-device/android/android-device
cordova.execCordovaOnPlatform = function (localPath, platformName, options) {
  var cordovaPath = path.join(localPath, 'cordova-build');

  // XXX error if an invalid platform
  var platform = platformName.split('-')[0];
  var isDevice = platformName.split('-')[1] === 'device';

  var args = [ isDevice ? 'run' : 'emulate',
               platform ];

  // XXX error if not a Cordova project
  execFileAsync('cordova', args, { cwd: cordovaPath });
  return 0;
};

// packages - list of strings
cordova.filterPackages = function (packages) {
// We hard-code the 'cordova' and 'platform' namespaces
  var ret = {
    rest: [],
    platforms: [],
    plugins: []
  };

  _.each(packages, function (p) {
    var namespace = p.split(':')[0];
    var name = p.split(':').slice(1).join(':');
    if (namespace === 'cordova') {
      checkIsValidPlugin(name);
      ret.plugins.push(name);
    } else if (namespace === 'platform') {
      if (! _.contains(supportedPlatforms, name))
        throw new Error(name + ": no such platform");
      ret.platforms.push(name);
    } else
      ret.rest.push(p); // leave it the same
  });
  return ret;
};
