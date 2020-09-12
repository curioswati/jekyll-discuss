var fs = require('fs');
var configFilePath = './config';
var config = require('ini').parse(fs.readFileSync(configFilePath, 'utf-8'));

module.exports = function (apiKey, sender) {
	var templatesDir = './email-templates/';
	var subjectExp = /<!--(.*?)-->/;
	var fs = require('fs');
    var sgMail = require('@sendgrid/mail');
    sgMail.setApiKey(apiKey);

	function readTemplate(template, callback) {
		fs.readFile(templatesDir + template + '.template.html', 'utf8', function (err, data) {
			if (!err) {
				var subject = data.match(subjectExp).slice(1)[0].trim();

				callback.call(undefined, subject, data);
			}
		});		
	}

	function send(template, recipient, content, callback) {
		readTemplate(template, function (subject, html) {
			for (placeholder in content) {
				if (content.hasOwnProperty(placeholder)) {
					html = html.replace('{{ ' + placeholder + ' }}', content[placeholder]);
				}
			}

            if (recipient === config.SUBSCRIPTIONS_NOTIFY_ALL) {
                var message = {
                    from: sender,
                    to: recipient,
                    subject: subject,
                    html: html,
                    replyTo: content['replyTo']
                };
            } else {
                var message = {
                    from: sender,
                    to: recipient,
                    subject: subject,
                    html: html,
                };
            }
            sgMail.send(message);
		});
	}

	return {
		send: send
	}
};
