var http		= require( "http" ),
	SunCalc		= require( "suncalc" ),
	moment		= require( "moment-timezone" ),
	geoTZ	 	= require( "geo-tz" ),

	// Define regex filters to match against location
	filters		= {
		gps: /^[-+]?([1-8]?\d(\.\d+)?|90(\.0+)?),\s*[-+]?(180(\.0+)?|((1[0-7]\d)|([1-9]?\d))(\.\d+)?)$/,
		pws: /^(?:pws|icao|zmw):/,
		url: /^https?:\/\/([\w\.-]+)(:\d+)?(\/.*)?$/,
		time: /(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})([+-])(\d{2})(\d{2})/,
		timezone: /^()()()()()()([+-])(\d{2})(\d{2})/
	};

// If location does not match GPS or PWS/ICAO, then attempt to resolve
// location using Weather Underground autocomplete API
function resolveCoordinates( location, callback ) {

	// Generate URL for autocomplete request
	var url = "http://autocomplete.wunderground.com/aq?h=0&query=" +
		encodeURIComponent( location );

	httpRequest( url, function( data ) {

		// Parse the reply for JSON data
		data = JSON.parse( data );

		// Check if the data is valid
		if ( typeof data.RESULTS === "object" && data.RESULTS.length && data.RESULTS[ 0 ].tz !== "MISSING" ) {

			// If it is, reply with an array containing the GPS coordinates
			callback( [ data.RESULTS[ 0 ].lat, data.RESULTS[ 0 ].lon ], moment().tz( data.RESULTS[ 0 ].tz ).utcOffset() );
		} else {

			// Otherwise, indicate no data was found
			callback( false );
		}
	} );
}

// Retrieve weather data from Open Weather Map
function getOWMWeatherData( location, callback ) {

	// Generate URL using OpenWeatherMap in Imperial units
	var OWM_API_KEY = process.env.OWM_API_KEY,
		forecastUrl = "http://api.openweathermap.org/data/2.5/forecast/daily?appid=" + OWM_API_KEY + "&units=imperial&lat=" + location[ 0 ] + "&lon=" + location[ 1 ];

	getTimeData( location, function( weather ) {

		// Perform the HTTP request to retrieve the weather data
		httpRequest( forecastUrl, function( data ) {
			try {
				data = JSON.parse( data );
			} catch ( err ) {

				// Otherwise indicate the request failed
				callback( weather );
				return;
			}

			if ( !data.list ) {
				callback(weather);
				return;
			}

			weather.region = data.city.country;
			weather.city = data.city.name;
			weather.minTemp = parseInt( data.list[ 0 ].temp.min );
			weather.maxTemp = parseInt( data.list[ 0 ].temp.max );
			weather.temp = ( weather.minTemp + weather.maxTemp ) / 2;
			weather.humidity = parseInt( data.list[ 0 ].humidity );
			weather.wind = parseInt( data.list[ 0 ].speed );
			weather.precip = ( data.list[ 0 ].rain ? parseFloat( data.list[ 0 ].rain || 0 ) : 0 ) / 25.4;
			weather.description = data.list[ 0 ].weather[ 0 ].description;
			weather.icon = data.list[ 0 ].weather[ 0 ].icon;
			weather.forecast = [];

			for ( var index = 0; index < data.list.length; index++ ) {
				weather.forecast.push( {
					temp_min: parseInt( data.list[ index ].temp.min ),
					temp_max: parseInt( data.list[ index ].temp.max ),
					date: parseInt( data.list[ index ].dt ),
					icon: data.list[ index ].weather[ 0 ].icon,
					description: data.list[ index ].weather[ 0 ].description
				} );
			}

			callback( weather );
		} );
	} );	
}

// Calculate timezone and sun rise/set information
function getTimeData( location, callback ) {
	var timezone = moment().tz( geoTZ( location[ 0 ], location[ 1 ] ) ).utcOffset();
	var tzOffset = getTimezone( timezone, "minutes" );

	// Calculate sunrise and sunset since Weather Underground does not provide it
	var sunData = SunCalc.getTimes( new Date(), location[ 0 ], location[ 1 ] );

	sunData.sunrise.setUTCMinutes( sunData.sunrise.getUTCMinutes() + tzOffset );
	sunData.sunset.setUTCMinutes( sunData.sunset.getUTCMinutes() + tzOffset );

	callback( {
		timezone:	timezone,
		sunrise:	( sunData.sunrise.getUTCHours() * 60 + sunData.sunrise.getUTCMinutes() ),
		sunset:		( sunData.sunset.getUTCHours() * 60 + sunData.sunset.getUTCMinutes() )
	} );
}

// Calculates the resulting water scale using the provided weather data, adjustment method and options
function calculateWeatherScale( adjustmentMethod, adjustmentOptions, weather ) {

	// Zimmerman method
	if ( adjustmentMethod === 1 ) {
		var humidityBase = 30, tempBase = 70, precipBase = 0;

		// Check to make sure valid data exists for all factors
		if ( !validateValues( [ "temp", "humidity", "precip" ], weather ) ) {
			return 100;
		}

		// Get baseline conditions for 100% water level, if provided
		if ( adjustmentOptions ) {
			humidityBase = adjustmentOptions.hasOwnProperty( "bh" ) ? adjustmentOptions.bh : humidityBase;
			tempBase = adjustmentOptions.hasOwnProperty( "bt" ) ? adjustmentOptions.bt : tempBase;
			precipBase = adjustmentOptions.hasOwnProperty( "br" ) ? adjustmentOptions.br : precipBase;
		}

		var temp = ( ( weather.maxTemp + weather.minTemp ) / 2 ) || weather.temp,
			humidityFactor = ( humidityBase - weather.humidity ),
			tempFactor = ( ( temp - tempBase ) * 4 ),
			precipFactor = ( ( precipBase - weather.precip ) * 200 );

		// Apply adjustment options, if provided, by multiplying the percentage against the factor
		if ( adjustmentOptions ) {
			if ( adjustmentOptions.hasOwnProperty( "h" ) ) {
				humidityFactor = humidityFactor * ( adjustmentOptions.h / 100 );
			}

			if ( adjustmentOptions.hasOwnProperty( "t" ) ) {
				tempFactor = tempFactor * ( adjustmentOptions.t / 100 );
			}

			if ( adjustmentOptions.hasOwnProperty( "r" ) ) {
				precipFactor = precipFactor * ( adjustmentOptions.r / 100 );
			}
		}

		// Apply all of the weather modifying factors and clamp the result between 0 and 200%.
		return parseInt( Math.min( Math.max( 0, 100 + humidityFactor + tempFactor + precipFactor ), 200 ) );
	}

	return -1;
}

// Checks if the weather data meets any of the restrictions set by OpenSprinkler.
// Restrictions prevent any watering from occurring and are similar to 0% watering level.
//
// California watering restriction prevents watering if precipitation over two days is greater
// than 0.01" over the past 48 hours.
function checkWeatherRestriction( adjustmentValue, weather ) {

	var californiaRestriction = ( adjustmentValue >> 7 ) & 1;

	if ( californiaRestriction ) {

		// If the California watering restriction is in use then prevent watering
		// if more then 0.01" of rain has accumulated in the past 48 hours
		if ( weather.precip > 0.01 ) {
			return true;
		}
	}

	return false;
}

// Checks if the weather indicates it is raining and returns a boolean representation
function checkRainStatus( weather ) {

	// Define all the weather codes that indicate rain
	var adverseCodes = [ 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 35, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47 ],
		adverseWords = [ "flurries", "sleet", "rain", "sleet", "snow", "tstorms" ];

	if ( ( weather.iconCode && adverseCodes.indexOf( weather.iconCode ) !== -1 ) || ( weather.icon && adverseWords.indexOf( weather.icon ) !== -1 ) ) {

		// If the current weather indicates rain, add a rain delay flag to the weather script indicating
		// the controller should not water.
		return true;
	}

	return false;
}

exports.showWeatherData = function( req, res ) {
	var location = req.query.loc;

	if ( filters.gps.test( location ) ) {

		// Handle GPS coordinates by storing each coordinate in an array
		location = location.split( "," );
		location = [ parseFloat( location[ 0 ] ), parseFloat( location[ 1 ] ) ];

		// Continue with the weather request
		getOWMWeatherData( location, function( data ) {
			data.location = location;
			res.json( data );
		} );
	} else {

		// Attempt to resolve provided location to GPS coordinates when it does not match
		// a GPS coordinate or Weather Underground location using Weather Underground autocomplete
		resolveCoordinates( location, function( result ) {
			if ( result === false ) {
				res.send( "Error: Unable to resolve location" );
				return;
			}

			location = result;
			getOWMWeatherData( location, function( data ) {
				data.location = location;
				res.json( data );
			} );
		} );
    }
};

// API Handler when using the weatherX.py where X represents the
// adjustment method which is encoded to also carry the watering
// restriction and therefore must be decoded
exports.getWeather = function( req, res ) {

	// The adjustment method is encoded by the OpenSprinkler firmware and must be
	// parsed. This allows the adjustment method and the restriction type to both
	// be saved in the same byte.
	var adjustmentMethod		= req.params[ 0 ] & ~( 1 << 7 ),
		adjustmentOptions		= req.query.wto,
		location				= req.query.loc,
		outputFormat			= req.query.format,
		remoteAddress			= req.headers[ "x-forwarded-for" ] || req.connection.remoteAddress,

		// Function that will accept the weather after it is received from the API
		// Data will be processed to retrieve the resulting scale, sunrise/sunset, timezone,
		// and also calculate if a restriction is met to prevent watering.
		finishRequest = function( weather ) {
			if ( !weather ) {
				if ( typeof location[ 0 ] === "number" && typeof location[ 1 ] === "number" ) {
					getTimeData( location, finishRequest );
				} else {
					res.send( "Error: No weather data found." );
				}

				return;
			}

			var scale = calculateWeatherScale( adjustmentMethod, adjustmentOptions, weather ),
				rainDelay = -1;

			// Check for any user-set restrictions and change the scale to 0 if the criteria is met
			if ( checkWeatherRestriction( req.params[ 0 ], weather ) ) {
				scale = 0;
			}

			// If any weather adjustment is being used, check the rain status
			if ( adjustmentMethod > 0 && checkRainStatus( weather ) ) {

				// If it is raining and the user has weather-based rain delay as the adjustment method then apply the specified delay
				if ( adjustmentMethod === 2 ) {

					rainDelay = ( adjustmentOptions && adjustmentOptions.hasOwnProperty( "d" ) ) ? adjustmentOptions.d : 24;
				} else {

					// For any other adjustment method, apply a scale of 0 (as the scale will revert when the rain stops)
					scale = 0;
				}
			}

			var data = {
					scale:		scale,
					rd:			rainDelay,
					tz:			getTimezone( weather.timezone ),
					sunrise:	weather.sunrise,
					sunset:		weather.sunset,
					eip:		ipToInt( remoteAddress )
				};

			// Return the response to the client in the requested format
			if ( outputFormat === "json" ) {
				res.json( data );
			} else {
				res.send(	"&scale="		+	data.scale +
							"&rd="			+	data.rd +
							"&tz="			+	data.tz +
							"&sunrise="		+	data.sunrise +
							"&sunset="		+	data.sunset +
							"&eip="			+	data.eip
				);
			}
		};

	// Exit if no location is provided
	if ( !location ) {
		res.send( "Error: No location provided." );
		return;
	}

	// X-Forwarded-For header may contain more than one IP address and therefore
	// the string is split against a comma and the first value is selected
	remoteAddress = remoteAddress.split( "," )[ 0 ];

	// Parse weather adjustment options
	try {

		// Parse data that may be encoded
		adjustmentOptions = decodeURIComponent( adjustmentOptions.replace( /\\x/g, "%" ) );

		// Reconstruct JSON string from deformed controller output
		adjustmentOptions = JSON.parse( "{" + adjustmentOptions + "}" );
	} catch ( err ) {

		// If the JSON is not valid, do not incorporate weather adjustment options
		adjustmentOptions = false;
	}

	// Parse location string
	if ( filters.pws.test( location ) ) {

		// Weather Underground is discontinued and PWS or ICAO cannot be resolved
		res.send( "Error: Weather Underground is discontinued." );
		return;
	} else if ( filters.gps.test( location ) ) {

		// Handle GPS coordinates by storing each coordinate in an array
		location = location.split( "," );
		location = [ parseFloat( location[ 0 ] ), parseFloat( location[ 1 ] ) ];

		// Continue with the weather request
		getOWMWeatherData( location, finishRequest );
	} else {

		// Attempt to resolve provided location to GPS coordinates when it does not match
		// a GPS coordinate or Weather Underground location using Weather Underground autocomplete
		resolveCoordinates( location, function( result ) {
			if ( result === false ) {
				res.send( "Error: Unable to resolve location" );
				return;
			}

			location = result;
			getOWMWeatherData( location, finishRequest );
		} );
    }
};

// Generic HTTP request handler that parses the URL and uses the
// native Node.js http module to perform the request
function httpRequest( url, callback ) {
	url = url.match( filters.url );

	var options = {
		host: url[ 1 ],
		port: url[ 2 ] || 80,
		path: url[ 3 ]
	};

	http.get( options, function( response ) {
        var data = "";

        // Reassemble the data as it comes in
        response.on( "data", function( chunk ) {
            data += chunk;
        } );

        // Once the data is completely received, return it to the callback
        response.on( "end", function() {
            callback( data );
        } );
	} ).on( "error", function() {

		// If the HTTP request fails, return false
		callback( false );
	} );
}

// Checks to make sure an array contains the keys provided and returns true or false
function validateValues( keys, array ) {
	var key;

	for ( key in keys ) {
		if ( !keys.hasOwnProperty( key ) ) {
			continue;
		}

		key = keys[ key ];

		if ( !array.hasOwnProperty( key ) || typeof array[ key ] !== "number" || isNaN( array[ key ] ) || array[ key ] === null || array[ key ] === -999 ) {
			return false;
		}
	}

	return true;
}

// Accepts a time string formatted in ISO-8601 or just the timezone
// offset and returns the timezone.
// The timezone output is formatted for OpenSprinkler Unified firmware.
function getTimezone( time, format ) {

	var hour, minute, tz;

	if ( typeof time === "number" ) {
		hour = Math.floor( time / 60 );
		minute = time % 60;
	} else {

		// Match the provided time string against a regex for parsing
		time = time.match( filters.time ) || time.match( filters.timezone );

		hour = parseInt( time[ 7 ] + time[ 8 ] );
		minute = parseInt( time[ 9 ] );
	}

	if ( format === "minutes" ) {
		tz = ( hour * 60 ) + minute;
	} else {

		// Convert the timezone into the OpenSprinkler encoded format
		minute = ( minute / 15 >> 0 ) / 4;
		hour = hour + ( hour >= 0 ? minute : -minute );

		tz = ( ( hour + 12 ) * 4 ) >> 0;
	}

	return tz;
}

// Converts IP string to integer
function ipToInt( ip ) {
    ip = ip.split( "." );
    return ( ( ( ( ( ( +ip[ 0 ] ) * 256 ) + ( +ip[ 1 ] ) ) * 256 ) + ( +ip[ 2 ] ) ) * 256 ) + ( +ip[ 3 ] );
}
