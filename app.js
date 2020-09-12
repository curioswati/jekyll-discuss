/*=====================================
=            Configuration            =
=====================================*/

var fs = require('fs');
var configFilePath = './config';
var config = require('ini').parse(fs.readFileSync(configFilePath, 'utf-8'));

/*-----  End of Configuration  ------*/

/*======================================
=            Module loading            =
======================================*/

var express = require('express');
var app = express();
var http = require('http');
var https = require('https');
var exec = require('child_process').exec;
var md5 = require('MD5');
var bodyParser = require('body-parser');
var marked = require('marked');
var subscriptions = require('./lib/subscriptions')(config.SUBSCRIPTIONS_DATABASE);
var mailman = require('./lib/mailman')(config.SENDGRID_KEY, config.SENDGRID_FROM);
var helpers = require('./lib/helpers');

/*-----  End of Module loading  ------*/

/*============================================
=            Module configuration            =
============================================*/

// Request body parser
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// Markdown parser
marked.setOptions({
	renderer: new marked.Renderer(),
	gfm: true,
	tables: true,
	breaks: false,
	pedantic: false,
	sanitize: true,
	smartLists: true,
	smartypants: false
});

/*-----  End of Module configuration  ------*/

/**
*
* Middleware: enable CORS
*
**/

app.use(function(req, res, next) {
	res.header("Access-Control-Allow-Origin", "*");
	res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
	next();
});

/**
*
* Endpoint: new comment
*
**/

app.post('/comments', function (req, res) {
	/**
	*
	* Expected data on POST:
	*
	* - name: Commenter's name
	* - email: Commenter's email address
	* - url: Commenter's website (optional)
	* - message: Comment
	* - company: honeypot field (will error if filled in)
	* - subscribe: Whether to subscribe the commenter to further comments (valid if == 'subscribe')
	* - post-slug: Post slug
	* - post-title: Post title
	* - post-url: Post URL (relative)
	*
	**/

	// Check for honeypot
	if (('company' in req.body) && req.body['company'].length) {
		res.status(500).send('You\'re not human, go away!');
		return;
	}	

	var requiredParameters = ['name', 'email', 'message', 'post-slug', 'post-title', 'post-url'];
	var parsedData = {};
	var validated = true;

	requiredParameters.forEach(function (element, index) {
		parsedData[element] = helpers.parseParameter(req.body[element], helpers.sanitize);
		validated = validated && parsedData[element];
	});

	// Create date
	var date = helpers.parseDate(new Date());
	
	// Create email hash
	var emailHash = md5(parsedData['email'].trim().toLowerCase());

	// Parse message with Markdown
	var message = marked(parsedData['message']);

	// Prepare shell command
	var shellCommand = './new-comment.sh';
	shellCommand += ' --config \'' + configFilePath + '\'';
	shellCommand += ' --name \'' + parsedData['name'] + '\'';
	shellCommand += ' --date \'' + helpers.sanitize(date) + '\'';
	shellCommand += ' --hash \'' + emailHash + '\'';
	shellCommand += ' --post \'' + parsedData['post-slug'] + '\'';
	shellCommand += ' --message \'' + helpers.parseParameter(message, helpers.sanitize) + '\'';	
	shellCommand += ' --commit-message \'' + config.GIT_COMMIT_MESSAGE + '\'';

	exec(shellCommand, function (error, stdout, stderr) { 
		if (error) {
			console.log('[!] Error running shell script: ' + error);
			res.status(500).send('Failed to add comment.');
		} else {
			var response = {
				hash: emailHash,
				date: date,
				message: message
			};

			res.send(JSON.stringify(response));
		}
	});

	// Getting subscribers
	subscriptions.get(parsedData['post-slug'], function (subscriptionsForPost) {
		subscriptionsForPost.forEach(function (subscription, index) {
			// Sending email
			var data = {
				title: parsedData['post-title'],
				slug: parsedData['post-slug'],
				link: parsedData['post-url'],
				subscriber: subscription.name,
				commenter: parsedData['name'],
				unsubscribe: subscription._id
			};

			mailman.send('new-comment', subscription.email, data, function (body, error) {
				if (error) {
					console.log('[!] Error sending email: ' + error);
				}
			});
		});

		// Notifying admin if that entry exists in the config and the admin is not the commenter
		if (('SUBSCRIPTIONS_NOTIFY_ALL' in config) && (config.SUBSCRIPTIONS_NOTIFY_ALL !== parsedData['email'])) {
			var data = {
				title: parsedData['post-title'],
				link: parsedData['post-url'],
				message: parsedData['message'],
				commenter: parsedData['name'],
                replyTo: parsedData['email']
			};

			mailman.send('admin-new-comment', config.SUBSCRIPTIONS_NOTIFY_ALL, data, function (body, error) {
				if (error) {
					console.log('[!] Error sending email: ' + error);
				}
			});			
		}
	}, [parsedData['email']]);

	// Subscribe the commenter if necessary
	if ((req.body['subscribe'] === 'subscribe') && 
		!(('SUBSCRIPTIONS_NOTIFY_ALL' in config) && (config.SUBSCRIPTIONS_NOTIFY_ALL === parsedData['email']))) {
		var newSubscriber = {
			name: parsedData['name'],
			email: parsedData['email'],
			post: parsedData['post-slug']
		};

		subscriptions.add(newSubscriber, parsedData['post-slug'], function (addedSubscriber) {
			if (addedSubscriber) {
				console.log('[*] Adding subscriber: ' + addedSubscriber.email + '...');
			}
		});	
	}
});

/**
*
* Endpoint: unsubscribe from notifications
*
**/

app.get('/unsubscribe/:id', function (req, res) {
	subscriptions.remove(req.params.id, function (numRemoved) {
		if (numRemoved > 0) {
			res.send('Subscription removed!');
		} else {
			res.status(404).send('Subscription not found.');
		}
	})
});

/**
*
* Server initialization
*
**/

var httpServer = http.createServer(app).listen(config.SERVER_HTTP_PORT, function () {
	var host = httpServer.address().address;
	var port = httpServer.address().port;

	console.log('[*] jekyll-discuss HTTP listening at http://%s:%s', host, port);	
});

if (('SERVER_HTTPS_KEY' in config) && ('SERVER_HTTPS_CRT' in config)) {
	var credentials = {
		key: fs.readFileSync(config.SERVER_HTTPS_KEY, 'utf8'),
		cert: fs.readFileSync(config.SERVER_HTTPS_CRT, 'utf8')
	};

	if ('SERVER_HTTPS_PASSPHRASE' in config) {
		credentials.passphrase = config.SERVER_HTTPS_PASSPHRASE;
	}

	var httpsServer = https.createServer(credentials, app).listen(config.SERVER_HTTPS_PORT, function () {
		var host = httpsServer.address().address;
		var port = httpsServer.address().port;

		console.log('[*] jekyll-discuss HTTPS listening at http://%s:%s', host, port);		
	});
}